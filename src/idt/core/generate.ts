import fs from 'node:fs';
import path from 'node:path';
import { compileIntent, type ModelClient } from './ir-compiler.js';
import type { ExtractTopologyOptions } from '../extract/topology.js';
import { emitSpec } from './emitter.js';
import { runPlaywrightSpec } from './runner.js';

export interface GenerateFlowOptions {
  projectRoot: string;
  intent: string;
  proseCase?: string;
  model: ModelClient;
  force?: boolean;
  yes?: boolean;
  runSpec?: (specPath: string) => Promise<{ exitCode: number; report: unknown }>;
  log?: (line: string) => void;
  extract?: ExtractTopologyOptions;
}

export async function generateFlow(options: {
  projectRoot: string;
  intent: string;
  proseCase?: string;
  model: ModelClient;
  force?: boolean;
  yes?: boolean;
  runSpec?: (specPath: string) => Promise<{ exitCode: number; report: unknown }>;
  log?: (line: string) => void;
  extract?: ExtractTopologyOptions;
}): Promise<{ exitCode: number; specPath: string }> {
  const { projectRoot, intent, proseCase, model, force, yes, runSpec, extract } = options;
  const log = options.log ?? console.log;

  // 1. Compile intent - rethrow error as-is, do not write spec
  const ir = await compileIntent({
    projectRoot,
    intent,
    proseCase,
    model,
    force,
    extract,
  });

  // 2. Emit spec and write to tests/e2e/generated/<flowId>.spec.ts
  const source = emitSpec(ir);
  const genDir = path.resolve(projectRoot, 'tests/e2e/generated');
  fs.mkdirSync(genDir, { recursive: true });

  const specPath = path.join(genDir, `${ir.flowId}.spec.ts`);
  const tmpSpecPath = `${specPath}.tmp`;

  fs.writeFileSync(tmpSpecPath, source, 'utf8');
  if (fs.existsSync(specPath)) {
    fs.unlinkSync(specPath);
  }
  fs.renameSync(tmpSpecPath, specPath);

  // 3. Log output
  log(`oracle: ${ir.oracle}`);
  const stages = [...ir.stages].sort((a, b) => a.stageIndex - b.stageIndex);
  for (const stage of stages) {
    log(`stage ${stage.stageIndex} ${stage.routePattern}`);
  }
  log(`Generated spec: ${specPath}`);

  // 4. Return early if yes is not true
  if (!yes) {
    return { exitCode: 0, specPath };
  }

  // 5. Run spec if yes is true
  const runResult = runSpec
    ? await runSpec(specPath)
    : await runPlaywrightSpec(specPath, projectRoot);

  if (runResult.exitCode === 0) {
    return { exitCode: 0, specPath };
  }

  return { exitCode: 1, specPath };
}
