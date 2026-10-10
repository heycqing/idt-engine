import fs from 'node:fs';
import path from 'node:path';
import { type StateTransitionIR } from './ir-schema.js';
import { emitSpec } from './emitter.js';
import { runPlaywrightSpec } from './runner.js';
import { replayUntil, launchChromiumReplay } from './replay.js';
import { parseAriaSnapshot } from './aria-snapshot.js';
import { chooseReplacement } from './similarity.js';

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

export function locateHealTarget(
  specSource: string,
  ir: StateTransitionIR,
  failure: { line: number; message: string },
): { stageIndex: number; actionIndex: number; role: string; name: string } {
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
  if (!lineText.includes('getByRole(')) {
    const err = new Error(`Line ${failure.line} does not contain getByRole(`);
    (err as any).exitCode = 2;
    throw err;
  }

  const matches = Array.from(
    lineText.matchAll(
      /getByRole\(\s*("(?:[^"\\]|\\.)*")\s*,\s*\{\s*name:\s*("(?:[^"\\]|\\.)*")\s*\}\)/g,
    ),
  );

  if (matches.length !== 1) {
    const err = new Error(
      `Line ${failure.line} does not contain exactly one getByRole(role, { name }) call`,
    );
    (err as any).exitCode = 2;
    throw err;
  }

  let role: string;
  let name: string;
  try {
    role = JSON.parse(matches[0][1]);
    name = JSON.parse(matches[0][2]);
  } catch (parseErr: any) {
    const err = new Error(`Failed to parse getByRole arguments: ${parseErr.message}`);
    (err as any).exitCode = 2;
    throw err;
  }

  // Collect IR actions in emitter emission order
  const emittedActions: Array<{
    stageIndex: number;
    actionIndex: number;
    role: string;
    name: string;
  }> = [];

  for (let stageIdx = 0; stageIdx < ir.stages.length; stageIdx++) {
    const stage = ir.stages[stageIdx];
    const actions = stage.actions;
    let triggerIndex = -1;
    if (actions.length > 0) {
      let lastTriggersRequestIndex = -1;
      for (let i = 0; i < actions.length; i++) {
        if (actions[i].triggersRequest) {
          lastTriggersRequestIndex = i;
        }
      }
      if (lastTriggersRequestIndex !== -1) {
        triggerIndex = lastTriggersRequestIndex;
      } else {
        triggerIndex = actions.length - 1;
      }
    }

    // Prior non-trigger actions
    for (let i = 0; i < actions.length; i++) {
      if (i !== triggerIndex) {
        emittedActions.push({
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
        stageIndex: stageIdx,
        actionIndex: triggerIndex,
        role: actions[triggerIndex].targetRole,
        name: actions[triggerIndex].targetName,
      });
    }
  }

  const matchedActions = emittedActions.filter(
    (a) => a.role === role && a.name === name,
  );

  if (matchedActions.length !== 1) {
    const err = new Error(
      `Expected unique action in IR matching role "${role}" and name "${name}", found ${matchedActions.length}`,
    );
    (err as any).exitCode = 2;
    throw err;
  }

  return matchedActions[0];
}

export interface HealOptions {
  projectRoot: string;
  specPath: string;
  runSpec?: (
    specPath: string,
  ) => Promise<{ exitCode: number; report: unknown }>;
  replay?: (
    ir: StateTransitionIR,
    target: { stageIndex: number; actionIndex: number; role: string; name: string },
  ) => Promise<string>;
}

export interface HealResult {
  exitCode: number;
  replaced?: boolean;
  newTargetName?: string;
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
    return { exitCode: 2 };
  }

  const specDir = path.dirname(resolvedSpecPath);
  const baseName = path.basename(resolvedSpecPath);
  const fileStem = baseName.slice(0, -'.spec.ts'.length);
  const irPath = path.join(specDir, `${fileStem}.ir.json`);

  if (!fs.existsSync(resolvedSpecPath) || !fs.existsSync(irPath)) {
    return { exitCode: 2 };
  }

  let originalSpecContent: string;
  let originalIrContent: string;
  try {
    originalSpecContent = fs.readFileSync(resolvedSpecPath, 'utf8');
    originalIrContent = fs.readFileSync(irPath, 'utf8');
  } catch {
    return { exitCode: 2 };
  }

  let ir: StateTransitionIR;
  try {
    ir = JSON.parse(originalIrContent);
  } catch {
    return { exitCode: 2 };
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
    return { exitCode: 2 };
  }

  const failure = firstFailure(firstRun.report);
  if (!failure) {
    return { exitCode: 2 };
  }

  let target: {
    stageIndex: number;
    actionIndex: number;
    role: string;
    name: string;
  };
  try {
    target = locateHealTarget(originalSpecContent, ir, failure);
  } catch {
    return { exitCode: 2 };
  }

  // 4. Replay
  const replayImpl =
    options.replay ??
    (async (currentIr, healTarget) => {
      return launchChromiumReplay(
        options.projectRoot,
        currentIr.setup?.storageStatePath,
        (page) => replayUntil(currentIr, healTarget, page),
      );
    });

  let snapshot: string;
  try {
    snapshot = await replayImpl(ir, target);
  } catch {
    return { exitCode: 2 };
  }

  // 5. Parse aria snapshot and choose replacement
  const elements = parseAriaSnapshot(snapshot);
  const candidateNames = elements
    .filter((el) => el.role === target.role)
    .map((el) => el.name);

  const choice = chooseReplacement(target.name, candidateNames);
  if (!choice.ok) {
    return { exitCode: 2 };
  }

  // 6. Update targetName in IR and re-emit spec
  const updatedIr: StateTransitionIR = JSON.parse(JSON.stringify(ir));
  updatedIr.stages[target.stageIndex].actions[target.actionIndex].targetName =
    choice.name;

  let newSpecContent: string;
  try {
    newSpecContent = emitSpec(updatedIr);
  } catch {
    return { exitCode: 2 };
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
  return { exitCode: 1 };
}
