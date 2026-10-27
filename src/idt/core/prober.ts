import fs from 'node:fs';
import path from 'node:path';
import { findTriggerActionIndex } from './action-order.js';
import { diffAriaSnapshots, type DomDeltaCandidate } from './dom-delta.js';
import { emitSpec } from './emitter.js';
import {
  AppearedRoleSchema,
  StateTransitionIRSchema,
  type Action,
  type StateTransitionIR,
} from './ir-schema.js';
import {
  launchChromiumReplay,
  replayUntil,
  type ReplayPage,
} from './replay.js';
import { readRouterOptions } from './route-url.js';

export interface ProbeTarget {
  stageIndex: number;
  actionIndex: number;
}

export interface ProbeOptions {
  projectRoot: string;
  irPath: string;
  baseUrl?: string;
  replay?: (
    ir: StateTransitionIR,
    target: ProbeTarget,
  ) => Promise<{ before: string; after: string }>;
}

export interface ProbeResult {
  exitCode: number;
  written?: boolean;
  delta?: { appearedRole: string; appearedName: string };
  candidates?: DomDeltaCandidate[];
  reason?: string;
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

export async function probe(options: ProbeOptions): Promise<ProbeResult> {
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

  const replayImpl = options.replay ?? (async (currentIr, currentTarget) =>
    launchChromiumReplay(
      options.projectRoot,
      currentIr.setup.storageStatePath,
      async (page) => {
        const router = readRouterOptions(options.projectRoot);
        const before = await replayUntil(currentIr, currentTarget, page, router);
        const action = currentIr.stages[currentTarget.stageIndex].actions[currentTarget.actionIndex];
        await executeAction(page, action);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        return { before, after: await page.ariaSnapshot() };
      },
      options.baseUrl,
    ));

  let snapshots: { before: string; after: string };
  try {
    snapshots = await replayImpl(ir, target);
  } catch (error) {
    return { exitCode: 2, reason: `重放取 aria 快照失败：${error instanceof Error ? error.message : error}` };
  }

  const candidates = diffAriaSnapshots(snapshots.before, snapshots.after);
  if (candidates.length === 0) {
    return { exitCode: 2, reason: '这个动作没有可观察的 DOM 效果' };
  }
  if (candidates.length > 1) {
    return { exitCode: 2, candidates };
  }

  const candidate = candidates[0];
  const role = AppearedRoleSchema.safeParse(candidate.role);
  if (!role.success) {
    return {
      exitCode: 2,
      reason:
        `探到的唯一增量是 (${candidate.role}, ${candidate.name})，`
        + `但 ${candidate.role} 不在 appearedRole 支持的取值里，断言写不出来。`
        + `确认它确实是该动作的证据的话，在 AppearedRoleSchema 里补上这个 role。`,
    };
  }
  const delta = { appearedRole: role.data, appearedName: candidate.name };
  const updatedIr = structuredClone(ir);
  updatedIr.stages[target.stageIndex].invariants.domDelta = delta;

  let specContent: string;
  try {
    specContent = emitSpec(updatedIr, readRouterOptions(options.projectRoot));
  } catch (error) {
    return { exitCode: 2, reason: `重新生成 spec 失败：${error instanceof Error ? error.message : error}` };
  }

  const stem = path.basename(irPath).replace(/\.ir\.json$/, '');
  const specPath = path.join(path.dirname(irPath), `${stem}.spec.ts`);
  atomicWrite(irPath, JSON.stringify(updatedIr, null, 2) + '\n');
  atomicWrite(specPath, specContent);
  return { exitCode: 0, written: true, delta };
}
