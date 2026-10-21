import path from 'node:path';
import { chromium } from '@playwright/test';
import type { StateTransitionIR } from './ir-schema.js';

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
  target: { stageIndex: number; actionIndex: number },
  page: ReplayPage,
): Promise<string> {
  // 1. page.goto(ir.initialRoute). Do not write hostname.
  await page.goto(ir.initialRoute);

  for (let stageIdx = 0; stageIdx < ir.stages.length; stageIdx++) {
    const stage = ir.stages[stageIdx];

    // Determine triggerIndex according to emitter.ts rules
    let triggerIndex = -1;
    if (stage.actions.length > 0) {
      let lastTriggersRequestIndex = -1;
      for (let i = 0; i < stage.actions.length; i++) {
        if (stage.actions[i].triggersRequest) {
          lastTriggersRequestIndex = i;
        }
      }
      if (lastTriggersRequestIndex !== -1) {
        triggerIndex = lastTriggersRequestIndex;
      } else {
        triggerIndex = stage.actions.length - 1;
      }
    }

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
    for (const actionIndex of emissionIndices) {
      if (stageIdx === target.stageIndex && actionIndex === target.actionIndex) {
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
    if (stageIdx < target.stageIndex && stage.invariants.routeGuard) {
      const guard = stage.invariants.routeGuard;
      const timeout = triggerIndex >= 0 ? stage.actions[triggerIndex].timeoutMs : 5000;
      await page.waitForURL(guard.targetUrlPattern, timeout);
    }
  }

  return await page.ariaSnapshot();
}

export async function launchChromiumReplay(
  projectRoot: string,
  storageStatePath: string | undefined,
  run: (page: ReplayPage) => Promise<string>,
  defaultBaseUrl: string | undefined = 'http://127.0.0.1:3000',
): Promise<string> {
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

    const replayPage: ReplayPage = {
      async goto(url: string) {
        await playwrightPage.goto(url);
      },
      async click(role: string, name: string, timeoutMs: number) {
        await playwrightPage
          .getByRole(role as any, { name })
          .click({ timeout: timeoutMs });
      },
      async fill(role: string, name: string, value: string, timeoutMs: number) {
        await playwrightPage
          .getByRole(role as any, { name })
          .fill(value, { timeout: timeoutMs });
      },
      async check(role: string, name: string, timeoutMs: number) {
        await playwrightPage
          .getByRole(role as any, { name })
          .check({ timeout: timeoutMs });
      },
      async selectOption(role: string, name: string, value: string, timeoutMs: number) {
        await playwrightPage
          .getByRole(role as any, { name })
          .selectOption(value, { timeout: timeoutMs });
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
