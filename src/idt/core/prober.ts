import fs from 'node:fs';
import path from 'node:path';
import { findTriggerActionIndex } from './action-order.js';
import {
  diffAriaSnapshots,
  diffObserved,
  type DomDeltaCandidate,
} from './dom-delta.js';
import { emitSpec } from './emitter.js';
import {
  AppearedRoleSchema,
  StateTransitionIRSchema,
  type Action,
  type DomDelta,
  type StateTransitionIR,
} from './ir-schema.js';
import {
  launchChromiumReplay,
  replayUntil,
  replayUntilCaptured,
  type ReplayPage,
} from './replay.js';
import { fromBrowserUrl, readRouterOptions } from './route-url.js';
import type { ObservedElement } from './dom-observe.js';
import { TAG_ROLES } from '../extract/vue-sfc.js';

export interface SelectorDeltaCandidate {
  selector: string;
  text?: string;
}

export type ProbeCandidate = DomDeltaCandidate | SelectorDeltaCandidate;

export interface ProbeReplayResult {
  before: string;
  after: string;
  beforeUrl: string;
  afterUrl: string;
  beforeObserved?: ObservedElement[];
  afterObserved?: ObservedElement[];
  hit?: string | null;
}

export interface ProbeTarget {
  stageIndex: number;
  actionIndex: number;
}

export interface ProbeOptions {
  projectRoot: string;
  irPath: string;
  baseUrl?: string;
  pick?: number;
  replay?: (
    ir: StateTransitionIR,
    target: ProbeTarget,
  ) => Promise<ProbeReplayResult>;
  launchReplay?: <T>(run: (page: ReplayPage) => Promise<T>) => Promise<T>;
}

export interface ProbeResult {
  exitCode: number;
  written?: boolean;
  evidence?: 'route' | 'dom';
  route?: { targetUrlPattern: string; discardedReady: boolean };
  delta?: DomDelta;
  candidates?: ProbeCandidate[];
  observation?: 'dom' | 'aria';
  reason?: string;
  hitMismatch?: { expected: string; actual: string };
}

/** 两条 CSS 路径是不是同一个元素，或互为祖先/后代。边界对齐到 ' > '。 */
function isSelfOrLineage(a: string, b: string): boolean {
  if (a === b) return true;
  return a.startsWith(`${b} > `) || b.startsWith(`${a} > `);
}

export function formatHitMismatchWarning(
  mismatch: NonNullable<ProbeResult['hitMismatch']>,
): string {
  return `警告：点击实际落在 ${mismatch.actual}，而 IR 指的是 ${mismatch.expected}`;
}

function atomicWrite(targetPath: string, content: string): void {
  const tmpPath = `${targetPath}.tmp`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
  fs.renameSync(tmpPath, targetPath);
}

async function executeAction(page: ReplayPage, action: Action): Promise<void> {
  const timeout = action.timeoutMs ?? 2000;
  switch (action.actionType) {
    case 'CLICK':
      await page.click(action.targetRole, action.targetName, timeout);
      return;
    case 'FILL':
      await page.fill(action.targetRole, action.targetName, action.inputValue ?? '', timeout);
      return;
    case 'CHECK':
      await page.check(action.targetRole, action.targetName, timeout);
      return;
    case 'SELECT':
      await page.selectOption(
        action.targetRole,
        action.targetName,
        action.inputValue ?? '',
        timeout,
      );
  }
}

function findProbeTarget(ir: StateTransitionIR): ProbeTarget | null {
  for (let stageIndex = 0; stageIndex < ir.stages.length; stageIndex++) {
    const stage = ir.stages[stageIndex];
    if (stage.invariants.domDelta || stage.actions.length === 0) continue;
    return {
      stageIndex,
      actionIndex: findTriggerActionIndex(stage.actions),
    };
  }
  return null;
}

function observedCandidates(
  before: ObservedElement[],
  after: ObservedElement[],
): ProbeCandidate[] {
  const appeared = diffObserved(before, after);

  // Prefer semantic locators: role/name evidence survives DOM refactors better
  // than a CSS structure path. Selector evidence is only the fallback layer.
  const semantic: DomDeltaCandidate[] = [];
  for (const element of appeared) {
    const roleValue = element.role?.trim() || TAG_ROLES[element.tag];
    const role = AppearedRoleSchema.safeParse(roleValue);
    const name = element.ownText || element.alt || '';
    if (role.success && name) semantic.push({ role: role.data, name });
  }
  if (semantic.length > 0) return semantic;

  return appeared.map((element) => ({
    selector: element.css,
    ...(element.ownText ? { text: element.ownText } : {}),
  }));
}

function targetCss(
  elements: ObservedElement[] | undefined,
  action: Action,
): string | null {
  if (!elements) return null;
  const target = elements.find((element) => {
    const name = element.ownText || element.alt || '';
    const role = element.role?.trim()
      || TAG_ROLES[element.tag]
      || (element.ownText ? 'text' : undefined);
    return role === action.targetRole && name === action.targetName;
  });
  return target?.css ?? null;
}

function findHitMismatch(
  ir: StateTransitionIR,
  target: ProbeTarget,
  replay: ProbeReplayResult,
): ProbeResult['hitMismatch'] {
  if (!replay.hit) return undefined;
  const action = ir.stages[target.stageIndex].actions[target.actionIndex];
  const expected = targetCss(replay.beforeObserved, action);
  if (!expected) return undefined;
  // 祖先/后代都算一致——点击冒泡到父容器是常见且正常的。
  // 但比较必须对齐到 ' > ' 分隔符：裸 startsWith 会把
  // 'div.foo > div.bar' 和 'div.foo > div.barbaz' 这种兄弟关系误判成祖先，
  // 真实的 mismatch 就被静默吞掉了。
  if (isSelfOrLineage(expected, replay.hit)) return undefined;
  return { expected, actual: replay.hit };
}

export async function probe(options: ProbeOptions): Promise<ProbeResult> {
  if (options.pick !== undefined && (!Number.isInteger(options.pick) || options.pick < 1)) {
    return { exitCode: 2, reason: '--pick 序号必须是从 1 开始的整数' };
  }

  const irPath = path.isAbsolute(options.irPath)
    ? options.irPath
    : path.resolve(options.projectRoot, options.irPath);

  let originalContent: string;
  let raw: unknown;
  try {
    originalContent = fs.readFileSync(irPath, 'utf8');
    raw = JSON.parse(originalContent);
  } catch (error) {
    return { exitCode: 2, reason: `读取 IR 失败：${error instanceof Error ? error.message : error}` };
  }

  const parsed = StateTransitionIRSchema.safeParse(raw);
  if (!parsed.success) {
    return { exitCode: 2, reason: `IR schema validation failed: ${parsed.error.message}` };
  }
  const ir = parsed.data;
  const target = findProbeTarget(ir);
  if (!target) {
    return { exitCode: 0, reason: '所有含动作的 stage 都已有 domDelta，没有待探测项' };
  }
  // timeoutMs 在 ActionSchema 上带 .default(5000)，解析之后一定有值。
  const waitMs = ir.stages[target.stageIndex].actions[target.actionIndex].timeoutMs;
  const router = readRouterOptions(options.projectRoot);

  const replayImpl = options.replay ?? (async (currentIr, currentTarget) => {
    const run = async (page: ReplayPage): Promise<ProbeReplayResult> => {
        const beforeFrame = await replayUntilCaptured(
          currentIr,
          currentTarget,
          page,
          router,
          async (currentPage) => {
            const observed = await currentPage.observe();
            const aria = await currentPage.ariaSnapshot();
            return { observed, aria };
          },
        );
        const beforeUrl = page.url();
        const action = currentIr.stages[currentTarget.stageIndex].actions[currentTarget.actionIndex];
        try {
          await page.installHitProbe();
        } catch {
          // The hit probe is optional and must never block the replay.
        }
        await executeAction(page, action);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        let hit: string | null = null;
        try {
          hit = await page.readHit();
        } catch {
          // A failed read is equivalent to no captured click.
        }
        const afterObserved = await page.observe();
        const needsAriaFallback = beforeFrame.observed.length === 0 || afterObserved.length === 0;
        const after = needsAriaFallback ? await page.ariaSnapshot() : '';
        return {
          before: beforeFrame.aria,
          after,
          beforeUrl,
          afterUrl: page.url(),
          beforeObserved: beforeFrame.observed,
          afterObserved,
          hit,
        };
      };
    if (options.launchReplay) return await options.launchReplay(run);
    return await launchChromiumReplay(
      options.projectRoot,
      currentIr.setup.storageStatePath,
      run,
      options.baseUrl,
    );
  });

  let snapshots: ProbeReplayResult;
  try {
    snapshots = await replayImpl(ir, target);
  } catch (error) {
    return { exitCode: 2, reason: `重放取 aria 快照失败：${error instanceof Error ? error.message : error}` };
  }

  const hitMismatch = findHitMismatch(ir, target, snapshots);
  const hitResult = hitMismatch ? { hitMismatch } : {};

  const beforeRoute = fromBrowserUrl(snapshots.beforeUrl, router);
  const afterRoute = fromBrowserUrl(snapshots.afterUrl, router);
  if (afterRoute && afterRoute !== beforeRoute) {
    if (options.pick !== undefined) {
      return {
        exitCode: 2,
        reason: 'URL 已变化，--pick 只适用于 DOM 增量候选，不能用于路由证据',
        ...hitResult,
      };
    }

    const updatedIr = structuredClone(ir);
    const invariants = updatedIr.stages[target.stageIndex].invariants;
    const discardedReady = Boolean(
      invariants.routeGuard?.readyRole || invariants.routeGuard?.readyName,
    );
    invariants.routeGuard = { targetUrlPattern: afterRoute };

    let specContent: string;
    try {
      specContent = emitSpec(updatedIr, router);
    } catch (error) {
      return {
        exitCode: 2,
        reason: `重新生成 spec 失败：${error instanceof Error ? error.message : error}`,
        ...hitResult,
      };
    }

    const stem = path.basename(irPath).replace(/\.ir\.json$/, '');
    const specPath = path.join(path.dirname(irPath), `${stem}.spec.ts`);
    atomicWrite(irPath, JSON.stringify(updatedIr, null, 2) + '\n');
    atomicWrite(specPath, specContent);
    return {
      exitCode: 0,
      written: true,
      evidence: 'route',
      route: { targetUrlPattern: afterRoute, discardedReady },
      ...hitResult,
    };
  }

  const useDom = Boolean(
    snapshots.beforeObserved?.length && snapshots.afterObserved?.length,
  );
  const observation: 'dom' | 'aria' = useDom ? 'dom' : 'aria';
  const candidates = useDom
    ? observedCandidates(snapshots.beforeObserved!, snapshots.afterObserved!)
    : diffAriaSnapshots(snapshots.before, snapshots.after);
  if (candidates.length === 0) {
    return { exitCode: 2, observation, reason: '这个动作没有可观察的 DOM 效果', ...hitResult };
  }
  if (options.pick === undefined && candidates.length > 1) {
    return { exitCode: 2, candidates, observation, ...hitResult };
  }
  if (options.pick !== undefined && options.pick > candidates.length) {
    return {
      exitCode: 2,
      reason: `只探到 ${candidates.length} 个 DOM 增量候选，不能选择第 ${options.pick} 个`,
      ...hitResult,
    };
  }

  const candidate = candidates[(options.pick ?? 1) - 1];
  if ('selector' in candidate) {
    const delta: DomDelta = {
      appearedSelector: candidate.selector,
      ...(candidate.text ? { appearedText: candidate.text } : {}),
    };
    const updatedIr = structuredClone(ir);
    updatedIr.stages[target.stageIndex].invariants.domDelta = delta;
    let specContent: string;
    try {
      specContent = emitSpec(updatedIr, router);
    } catch (error) {
      return { exitCode: 2, observation, reason: `重新生成 spec 失败：${error instanceof Error ? error.message : error}`, ...hitResult };
    }
    const stem = path.basename(irPath).replace(/\.ir\.json$/, '');
    const specPath = path.join(path.dirname(irPath), `${stem}.spec.ts`);
    atomicWrite(irPath, JSON.stringify(updatedIr, null, 2) + '\n');
    atomicWrite(specPath, specContent);
    return { exitCode: 0, written: true, evidence: 'dom', delta, observation, ...hitResult };
  }
  const role = AppearedRoleSchema.safeParse(candidate.role);
  if (!role.success) {
    return {
      exitCode: 2,
      reason:
        `探到的唯一增量是 (${candidate.role}, ${candidate.name})，`
        + `但 ${candidate.role} 不在 appearedRole 支持的取值里，断言写不出来。`
        + `确认它确实是该动作的证据的话，在 AppearedRoleSchema 里补上这个 role。`,
      ...hitResult,
    };
  }
  const delta = { appearedRole: role.data, appearedName: candidate.name };
  const updatedIr = structuredClone(ir);
  updatedIr.stages[target.stageIndex].invariants.domDelta = delta;

  let specContent: string;
  try {
    specContent = emitSpec(updatedIr, router);
  } catch (error) {
    return { exitCode: 2, reason: `重新生成 spec 失败：${error instanceof Error ? error.message : error}`, ...hitResult };
  }

  const stem = path.basename(irPath).replace(/\.ir\.json$/, '');
  const specPath = path.join(path.dirname(irPath), `${stem}.spec.ts`);
  atomicWrite(irPath, JSON.stringify(updatedIr, null, 2) + '\n');
  atomicWrite(specPath, specContent);
  return { exitCode: 0, written: true, evidence: 'dom', delta, observation, ...hitResult };
}
