import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IdtProject } from '../config/projects.js';
import type { ProjectTopology } from '../schemas/topology.schema.js';
import { StateTransitionIRSchema, type StateTransitionIR } from './ir-schema.js';
import { ObservationCandidateSchema } from './observation-schema.js';
import { artifactStem } from './artifact-name.js';
import { emitSpec } from './emitter.js';
import { exactRoute } from './route-pattern.js';
import { routerUrlOptions, type RouterUrlOptions } from './route-url-pure.js';
import { validateIr } from './validate-ir.js';

export interface PromoteOptions {
  projectRoot: string;
  project: string | IdtProject;
  candidatePath: string;
  topology: ProjectTopology;
  router?: RouterUrlOptions;
  renameFile?: (source: string, target: string) => void;
}

export interface PromoteResult {
  flowId: string;
  irPath: string;
  specPath: string;
}

function projectName(project: string | IdtProject): string {
  return typeof project === 'string' ? project : project.name;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateCurrentTopology(ir: StateTransitionIR, topology: ProjectTopology): void {
  const routes = [ir.initialRoute, ...ir.stages.map((stage) => stage.routePattern)];
  for (const route of routes) {
    if (!Object.hasOwn(topology.routes, route)) throw new Error(`Candidate references unknown route ${route}`);
  }
  for (const stage of ir.stages) {
    const route = topology.routes[stage.routePattern];
    for (const action of stage.actions) {
      const matches = route.elements.filter((element) =>
        element.role === action.targetRole && element.name === action.targetName,
      );
      if (matches.length !== 1 || matches[0].dynamic || matches[0].deferred || matches[0].dataScoped) {
        throw new Error(`Candidate action target is not a unique stable topology element (${action.targetRole}, ${action.targetName})`);
      }
    }
    const guard = stage.invariants.routeGuard;
    if (guard?.readyRole && guard.readyName) {
      const targetRoute = exactRoute(guard.targetUrlPattern);
      const readyRoute = topology.routes[targetRoute] ? targetRoute : stage.routePattern;
      const matches = topology.routes[readyRoute].elements.filter((element) =>
        element.role === guard.readyRole && element.name === guard.readyName,
      );
      if (matches.length !== 1 || matches[0].dynamic || matches[0].deferred || matches[0].dataScoped) {
        throw new Error(`Candidate readiness target is not a unique stable topology element (${guard.readyRole}, ${guard.readyName})`);
      }
    }
  }
}

export async function promote(options: PromoteOptions): Promise<PromoteResult> {
  const name = projectName(options.project);
  if (name !== path.basename(name) || name === '.' || name === '..' || /[\\/]/.test(name)) {
    throw new Error('Project name is not a safe promotion directory name');
  }
  const projectRoot = fs.realpathSync(path.resolve(options.projectRoot));
  const observationsRoot = path.join(projectRoot, '.idt', 'observations');
  const projectObservations = path.join(observationsRoot, name);
  if (!fs.existsSync(projectObservations)) throw new Error(`Project observation directory does not exist for ${name}`);
  const realProjectObservations = fs.realpathSync(projectObservations);
  if (!isInside(fs.realpathSync(observationsRoot), realProjectObservations)) {
    throw new Error('Project observation directory resolves outside the ignored observation root');
  }
  const candidatePath = fs.realpathSync(path.resolve(options.candidatePath));
  if (!isInside(realProjectObservations, candidatePath) || path.basename(candidatePath) !== 'candidate.ir.json') {
    throw new Error('Candidate must be candidate.ir.json inside the selected project observation directory');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  } catch {
    throw new Error('Candidate observation file is unreadable JSON');
  }
  const parsed = ObservationCandidateSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Candidate IR schema is invalid: ${parsed.error.message}`);
  const ir = StateTransitionIRSchema.parse(parsed.data);
  if (ir.unresolved.length > 0) throw new Error('Candidate contains unresolved items and cannot be promoted');
  if (options.topology.project && options.topology.project !== name) {
    throw new Error('Selected project does not match the current topology');
  }
  validateCurrentTopology(ir, options.topology);
  const router = options.router ?? routerUrlOptions(options.topology);
  const routePath = ir.stages.map((stage) => stage.routePattern);
  validateIr(ir, { projectRoot, routePath, mode: 'emit', fileStem: artifactStem(ir) });
  const specSource = emitSpec(ir, router);

  const generatedDir = path.join(projectRoot, 'tests', 'e2e', 'generated');
  fs.mkdirSync(generatedDir, { recursive: true });
  const realGeneratedDir = fs.realpathSync(generatedDir);
  if (!isInside(projectRoot, realGeneratedDir)) throw new Error('Generated output directory resolves outside the project root');
  const stem = artifactStem(ir);
  const irPath = path.join(generatedDir, `${stem}.ir.json`);
  const specPath = path.join(generatedDir, `${stem}.spec.ts`);
  if (fs.existsSync(irPath) || fs.existsSync(specPath)) {
    throw new Error(`Active flow ${ir.flowId} already exists; promotion does not overwrite active cases`);
  }

  const stageDir = path.join(projectRoot, '.idt', 'promotions', randomUUID());
  fs.mkdirSync(stageDir, { recursive: true });
  const stagedIr = path.join(stageDir, `${stem}.ir.json`);
  const stagedSpec = path.join(stageDir, `${stem}.spec.ts`);
  const rename = options.renameFile ?? fs.renameSync;
  let wroteIr = false;
  let wroteSpec = false;
  try {
    fs.writeFileSync(stagedIr, JSON.stringify(ir, null, 2) + '\n', 'utf8');
    fs.writeFileSync(stagedSpec, specSource, 'utf8');
    rename(stagedIr, irPath);
    wroteIr = true;
    rename(stagedSpec, specPath);
    wroteSpec = true;
    return { flowId: ir.flowId, irPath, specPath };
  } catch {
    if (wroteIr) {
      try { fs.rmSync(irPath, { force: true }); } catch { /* retain the original promotion failure */ }
    }
    if (wroteSpec) {
      try { fs.rmSync(specPath, { force: true }); } catch { /* retain the original promotion failure */ }
    }
    throw new Error('Candidate promotion failed atomically; active artifacts were not retained');
  } finally {
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* staging is ignored; preserve promotion result */ }
  }
}
