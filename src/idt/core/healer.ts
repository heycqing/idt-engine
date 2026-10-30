import fs from 'node:fs';
import path from 'node:path';
import { type StateTransitionIR } from './ir-schema.js';
import { emitSpec } from './emitter.js';
import { runPlaywrightSpec } from './runner.js';
import { replayUntil, launchChromiumReplay } from './replay.js';
import { readRouterOptions } from './route-url.js';
import { parseAriaSnapshot } from './aria-snapshot.js';
import { chooseReplacement } from './similarity.js';
import { findTriggerActionIndex } from './action-order.js';

export function firstFailure(
  report: unknown,
): { line: number; message: string } | null {
  if (!report || typeof report !== 'object') return null;

  function traverse(node: any): { line: number; message: string } | null {
    if (!node || typeof node !== 'object') return null;

    if (Array.isArray(node.results)) {
      for (const res of node.results) {
        if (res && (res.status === 'failed' || res.status === 'timedOut')) {
          const errors = Array.isArray(res.errors) ? res.errors : [];
          const errWithLine = errors.find(
            (e: any) =>
              e?.location?.line !== undefined &&
              typeof e.location.line === 'number',
          );
          const message = errors
            .map((e: any) => (typeof e?.message === 'string' ? e.message : ''))
            .filter(Boolean)
            .join('\n');
          if (!errWithLine) {
            return { line: 0, message };
          }
          return {
            line: errWithLine.location.line,
            message,
          };
        }
      }
    }

    if (Array.isArray(node.tests)) {
      for (const test of node.tests) {
        const found = traverse(test);
        if (found) return found;
      }
    }

    if (Array.isArray(node.specs)) {
      for (const spec of node.specs) {
        const found = traverse(spec);
        if (found) return found;
      }
    }

    if (Array.isArray(node.suites)) {
      for (const suite of node.suites) {
        const found = traverse(suite);
        if (found) return found;
      }
    }

    return null;
  }

  return traverse(report);
}

/**
 * 自愈目标。action 指某条动作的 targetName，routeGuard 指 stage 的
 * readyName —— 后者在 emit 出来的 spec 里同样是一行 getByRole，
 * 此前只扫 actions，断言失败时直接报"定位不到可自愈的目标"。
 */
export interface HealTarget {
  kind: 'action' | 'routeGuard';
  stageIndex: number;
  actionIndex: number;
  role: string;
  name: string;
}

export function locateHealTarget(
  specSource: string,
  ir: StateTransitionIR,
  failure: { line: number; message: string },
): HealTarget {
  if (!failure.message.includes('Timeout')) {
    const err = new Error('Failure message does not contain Timeout');
    (err as any).exitCode = 2;
    throw err;
  }

  const lines = specSource.split(/\r?\n/);
  if (failure.line < 1 || failure.line > lines.length) {
    const err = new Error(`Failure line ${failure.line} out of range`);
    (err as any).exitCode = 2;
    throw err;
  }

  const lineText = lines[failure.line - 1];
  const roleMatches = Array.from(
    lineText.matchAll(
      /getByRole\(\s*("(?:[^"\\]|\\.)*")\s*,\s*\{\s*name:\s*("(?:[^"\\]|\\.)*")(?:\s*,\s*exact:\s*true)?\s*\}\)/g,
    ),
  );
  const textMatches = Array.from(
    lineText.matchAll(
      /getByText\(\s*("(?:[^"\\]|\\.)*")\s*,\s*\{\s*exact:\s*true\s*\}\)/g,
    ),
  );

  if (roleMatches.length + textMatches.length !== 1) {
    const err = new Error(
      `Line ${failure.line} does not contain exactly one supported named locator call`,
    );
    (err as any).exitCode = 2;
    throw err;
  }

  let role: string;
  let name: string;
  try {
    if (roleMatches.length === 1) {
      role = JSON.parse(roleMatches[0][1]);
      name = JSON.parse(roleMatches[0][2]);
    } else {
      role = 'text';
      name = JSON.parse(textMatches[0][1]);
    }
  } catch (parseErr: any) {
    const err = new Error(`Failed to parse locator arguments: ${parseErr.message}`);
    (err as any).exitCode = 2;
    throw err;
  }

  // Collect IR actions in emitter emission order
  const emittedActions: HealTarget[] = [];

  for (let stageIdx = 0; stageIdx < ir.stages.length; stageIdx++) {
    const stage = ir.stages[stageIdx];
    const actions = stage.actions;
    const triggerIndex = findTriggerActionIndex(actions);

    // Prior non-trigger actions
    for (let i = 0; i < actions.length; i++) {
      if (i !== triggerIndex) {
        emittedActions.push({
          kind: 'action',
          stageIndex: stageIdx,
          actionIndex: i,
          role: actions[i].targetRole,
          name: actions[i].targetName,
        });
      }
    }

    // Trigger action
    if (triggerIndex >= 0) {
      emittedActions.push({
        kind: 'action',
        stageIndex: stageIdx,
        actionIndex: triggerIndex,
        role: actions[triggerIndex].targetRole,
        name: actions[triggerIndex].targetName,
      });
    }

    // routeGuard 的 ready 断言紧跟在本 stage 的动作之后被 emit 出来
    const guard = stage.invariants.routeGuard;
    if (guard?.readyRole && guard.readyName) {
      emittedActions.push({
        kind: 'routeGuard',
        stageIndex: stageIdx,
        actionIndex: Math.max(actions.length - 1, 0),
        role: guard.readyRole,
        name: guard.readyName,
      });
    }
  }

  const matchedActions = emittedActions.filter(
    (a) => a.role === role && a.name === name,
  );

  if (matchedActions.length !== 1) {
    const err = new Error(
      `IR 里匹配 role "${role}" 且 name "${name}" 的可自愈位置不唯一，找到 ${matchedActions.length} 个`,
    );
    (err as any).exitCode = 2;
    throw err;
  }

  return matchedActions[0];
}

export interface HealOptions {
  projectRoot: string;
  specPath: string;
  /** 项目的开发服务器地址。不给就沿用 replay 的默认值。 */
  baseUrl?: string;
  runSpec?: (
    specPath: string,
  ) => Promise<{ exitCode: number; report: unknown }>;
  replay?: (ir: StateTransitionIR, target: HealTarget) => Promise<string>;
}

export interface HealResult {
  exitCode: number;
  replaced?: boolean;
  newTargetName?: string;
  /** 失败原因。每个失败分支都带上，否则调用方只看到一个退出码。 */
  reason?: string;
}

function atomicWrite(targetPath: string, content: string): void {
  const tmpPath = `${targetPath}.tmp`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  if (fs.existsSync(targetPath)) {
    fs.unlinkSync(targetPath);
  }
  fs.renameSync(tmpPath, targetPath);
}

export async function heal(options: HealOptions): Promise<HealResult> {
  const resolvedSpecPath = path.isAbsolute(options.specPath)
    ? options.specPath
    : path.resolve(options.projectRoot, options.specPath);

  if (!resolvedSpecPath.endsWith('.spec.ts')) {
    return { exitCode: 2, reason: `不是 .spec.ts 文件：${resolvedSpecPath}` };
  }

  const specDir = path.dirname(resolvedSpecPath);
  const baseName = path.basename(resolvedSpecPath);
  const fileStem = baseName.slice(0, -'.spec.ts'.length);
  const irPath = path.join(specDir, `${fileStem}.ir.json`);

  if (!fs.existsSync(resolvedSpecPath) || !fs.existsSync(irPath)) {
    return { exitCode: 2, reason: `spec 或同名 .ir.json 不存在：${resolvedSpecPath}` };
  }

  let originalSpecContent: string;
  let originalIrContent: string;
  try {
    originalSpecContent = fs.readFileSync(resolvedSpecPath, 'utf8');
    originalIrContent = fs.readFileSync(irPath, 'utf8');
  } catch {
    return { exitCode: 2, reason: '读取 spec 或 IR 失败' };
  }

  let ir: StateTransitionIR;
  try {
    ir = JSON.parse(originalIrContent);
  } catch {
    return { exitCode: 2, reason: 'IR 不是合法 JSON' };
  }

  const runSpecImpl =
    options.runSpec ??
    (async (spec) => {
      return runPlaywrightSpec(spec, options.projectRoot);
    });

  // 1. Run spec first time
  const firstRun = await runSpecImpl(resolvedSpecPath);

  // 2. If exitCode is 0: already passed
  if (firstRun.exitCode === 0) {
    return { exitCode: 0, replaced: false };
  }

  // 3. Locate failure and heal target
  if (!firstRun.report) {
    return { exitCode: 2, reason: '没有拿到 Playwright 的 JSON 报告' };
  }

  const failure = firstFailure(firstRun.report);
  if (!failure) {
    return { exitCode: 2, reason: '报告里没有失败用例，无从自愈' };
  }

  let target: HealTarget;
  try {
    target = locateHealTarget(originalSpecContent, ir, failure);
  } catch (err: any) {
    return {
      exitCode: 2,
      reason: `定位不到可自愈的目标：${err?.message ?? err}`,
    };
  }

  // 4. Replay
  const replayImpl =
    options.replay ??
    (async (currentIr, healTarget) => {
      return launchChromiumReplay(
        options.projectRoot,
        currentIr.setup?.storageStatePath,
        (page) => replayUntil(currentIr, healTarget, page, readRouterOptions(options.projectRoot)),
        options.baseUrl,
      );
    });

  let snapshot: string;
  try {
    snapshot = await replayImpl(ir, target);
  } catch (err: any) {
    return { exitCode: 2, reason: `重放取 aria 快照失败：${err?.message ?? err}` };
  }

  // 5. Parse aria snapshot and choose replacement
  const elements = parseAriaSnapshot(snapshot);
  const candidateNames = elements
    .filter((el) => el.role === target.role)
    .map((el) => el.name);

  const choice = chooseReplacement(target.name, candidateNames);
  if (!choice.ok) {
    return {
      exitCode: 2,
      reason:
        `aria 快照里没有足够接近 "${target.name}" 的 ${target.role}。` +
        `候选：${candidateNames.length ? candidateNames.join(' / ') : '（无）'}`,
    };
  }

  // 6. Update targetName in IR and re-emit spec
  const updatedIr: StateTransitionIR = JSON.parse(JSON.stringify(ir));
  if (target.kind === 'routeGuard') {
    const guard = updatedIr.stages[target.stageIndex].invariants.routeGuard;
    if (!guard) {
      return { exitCode: 2, reason: '目标 stage 上已经没有 routeGuard 了' };
    }
    guard.readyName = choice.name;
  } else {
    updatedIr.stages[target.stageIndex].actions[target.actionIndex].targetName =
      choice.name;
  }

  let newSpecContent: string;
  try {
    // 必须带上路由模式，否则自愈会把 hash 地址重写成 history
    newSpecContent = emitSpec(updatedIr, readRouterOptions(options.projectRoot));
  } catch (err: any) {
    return { exitCode: 2, reason: `重新生成 spec 失败：${err?.message ?? err}` };
  }

  const updatedIrJson = JSON.stringify(updatedIr, null, 2) + '\n';
  atomicWrite(irPath, updatedIrJson);
  atomicWrite(resolvedSpecPath, newSpecContent);

  // 7. Run spec second time
  const secondRun = await runSpecImpl(resolvedSpecPath);
  if (secondRun.exitCode === 0) {
    return {
      exitCode: 0,
      replaced: true,
      newTargetName: choice.name,
    };
  }

  // 8. Re-run failed: revert to original bytes
  atomicWrite(irPath, originalIrContent);
  atomicWrite(resolvedSpecPath, originalSpecContent);
  return {
    exitCode: 1,
    reason: `换成 "${choice.name}" 后重跑仍然失败，已回滚到原始内容`,
  };
}
