import path from 'node:path';
import {
  DEFAULT_ROUTER_URL_OPTIONS,
  toBrowserUrl,
  toGuardPattern,
  type RouterUrlOptions,
} from './route-url.js';
import { chromium } from '@playwright/test';
import type { StateTransitionIR } from './ir-schema.js';
import { findTriggerActionIndex } from './action-order.js';

export interface ReplayPage {
  goto(url: string): Promise<void>;
  click(role: string, name: string, timeoutMs: number): Promise<void>;
  fill(role: string, name: string, value: string, timeoutMs: number): Promise<void>;
  check(role: string, name: string, timeoutMs: number): Promise<void>;
  selectOption(role: string, name: string, value: string, timeoutMs: number): Promise<void>;
  waitForURL(pattern: string, timeoutMs: number): Promise<void>;
  ariaSnapshot(): Promise<string>;
}

export async function replayUntil(
  ir: StateTransitionIR,
  target: { stageIndex: number; actionIndex: number; kind?: 'action' | 'routeGuard' },
  page: ReplayPage,
  router: RouterUrlOptions = DEFAULT_ROUTER_URL_OPTIONS,
): Promise<string> {
  // 1. page.goto(初始路由装配出的地址)。不写主机名。
  await page.goto(toBrowserUrl(ir.initialRoute, router));

  for (let stageIdx = 0; stageIdx < ir.stages.length; stageIdx++) {
    const stage = ir.stages[stageIdx];

    // Determine triggerIndex according to emitter.ts rules
    const triggerIndex = findTriggerActionIndex(stage.actions);

    // Build emission order: non-trigger actions first, then trigger action
    const emissionIndices: number[] = [];
    for (let i = 0; i < stage.actions.length; i++) {
      if (i !== triggerIndex) {
        emissionIndices.push(i);
      }
    }
    if (triggerIndex >= 0) {
      emissionIndices.push(triggerIndex);
    }

    // Execute actions in emission order
    // routeGuard 目标要把本 stage 的动作跑完再取快照，所以不在动作处停
    const stopAtAction = target.kind !== 'routeGuard';

    for (const actionIndex of emissionIndices) {
      if (stopAtAction && stageIdx === target.stageIndex && actionIndex === target.actionIndex) {
        // Stop at failure action. Do not execute the failure action itself.
        // Stage containing failure action does not execute route guard.
        return await page.ariaSnapshot();
      }

      const action = stage.actions[actionIndex];
      switch (action.actionType) {
        case 'CLICK':
          await page.click(action.targetRole, action.targetName, action.timeoutMs);
          break;
        case 'FILL':
          await page.fill(
            action.targetRole,
            action.targetName,
            action.inputValue ?? '',
            action.timeoutMs,
          );
          break;
        case 'CHECK':
          await page.check(action.targetRole, action.targetName, action.timeoutMs);
          break;
        case 'SELECT':
          await page.selectOption(
            action.targetRole,
            action.targetName,
            action.inputValue ?? '',
            action.timeoutMs,
          );
          break;
      }
    }

    // When all actions in this stage precede the failure action,
    // if this stage has routeGuard, call page.waitForURL
    const isGuardTarget =
      target.kind === 'routeGuard' && stageIdx === target.stageIndex;

    if ((stageIdx < target.stageIndex || isGuardTarget) && stage.invariants.routeGuard) {
      const guard = stage.invariants.routeGuard;
      const timeout = triggerIndex >= 0 ? stage.actions[triggerIndex].timeoutMs : 5000;
      await page.waitForURL(toGuardPattern(guard.targetUrlPattern, router), timeout);
    }

    // ready 断言就在 waitForURL 之后，此刻的页面状态正是要比对的那一帧
    if (isGuardTarget) {
      return await page.ariaSnapshot();
    }
  }

  return await page.ariaSnapshot();
}

export async function launchChromiumReplay<T>(
  projectRoot: string,
  storageStatePath: string | undefined,
  run: (page: ReplayPage) => Promise<T>,
  defaultBaseUrl: string | undefined = 'http://127.0.0.1:3000',
): Promise<T> {
  const browser = await chromium.launch({ headless: true });
  try {
    const baseURL = process.env.IDT_BASE_URL || defaultBaseUrl || 'http://127.0.0.1:3000';
    const contextOptions: { baseURL: string; storageState?: string } = {
      baseURL,
    };
    if (storageStatePath) {
      contextOptions.storageState = path.resolve(projectRoot, storageStatePath);
    }
    const context = await browser.newContext(contextOptions);
    const playwrightPage = await context.newPage();

    // text 是伪 role，用 getByText 定位，与 emitter 保持一致
    const locate = (role: string, name: string) =>
      role === 'text'
        ? playwrightPage.getByText(name, { exact: true })
        : playwrightPage.getByRole(role as any, { name });

    const replayPage: ReplayPage = {
      async goto(url: string) {
        await playwrightPage.goto(url);
      },
      async click(role: string, name: string, timeoutMs: number) {
        await locate(role, name).click({ timeout: timeoutMs });
      },
      async fill(role: string, name: string, value: string, timeoutMs: number) {
        await locate(role, name).fill(value, { timeout: timeoutMs });
      },
      async check(role: string, name: string, timeoutMs: number) {
        await locate(role, name).check({ timeout: timeoutMs });
      },
      async selectOption(role: string, name: string, value: string, timeoutMs: number) {
        await locate(role, name).selectOption(value, { timeout: timeoutMs });
      },
      async waitForURL(pattern: string, timeoutMs: number) {
        await playwrightPage.waitForURL(new RegExp(pattern), {
          timeout: timeoutMs,
        });
      },
      async ariaSnapshot() {
        return await playwrightPage.locator('body').ariaSnapshot();
      },
    };

    return await run(replayPage);
  } finally {
    await browser.close();
  }
}
