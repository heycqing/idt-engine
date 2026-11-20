import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emitSpec } from '../../../src/idt/core/emitter.js';
import type { StateTransitionIR } from '../../../src/idt/core/ir-schema.js';
import type { ProjectTopology } from '../../../src/idt/schemas/topology.schema.js';
import { promote, type PromoteOptions } from '../../../src/idt/core/promoter.js';

function topology(): ProjectTopology {
  const route = (path: string) => ({
    path, filePath: 'fixture.vue', title: '', semanticKeywords: [],
    dynamicParams: [], transitions: [], elements: [{ role: 'button' as const, name: 'Open' }],
  });
  return {
    version: '1.0.0', project: 'caida', generatedAt: '', sourceDigest: 'a'.repeat(64),
    router: { mode: 'history', base: '/' },
    routes: { '/start': route('/start'), '/next': route('/next') },
  };
}

function candidate(unresolved: string[] = []): StateTransitionIR {
  return {
    flowId: 'flow_aabbccddee', intent: 'Open details', oracle: 'regression-lock',
    description: 'Open details', initialRoute: '/start', setup: { notes: [] }, unresolved,
    stages: [{
      stageIndex: 0, stageName: 'Open details', routePattern: '/start',
      actions: [{ actionType: 'CLICK', targetRole: 'button', targetName: 'Open', timeoutMs: 5000, triggersRequest: false }],
      invariants: { network: [], routeGuard: { targetUrlPattern: '^/next$' } },
    }],
  };
}

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'idt-promote-'));
}

function writeCandidate(root: string, project = 'caida', ir = candidate()): string {
  const dir = path.join(root, '.idt', 'observations', project, 'run-1');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'candidate.ir.json');
  fs.writeFileSync(file, JSON.stringify(ir), 'utf8');
  return file;
}

function options(root: string, candidatePath: string, overrides: Partial<PromoteOptions> = {}): PromoteOptions {
  return {
    projectRoot: root, project: 'caida', candidatePath, topology: topology(),
    ...overrides,
  };
}

describe('promote observation candidate', () => {
  it('rejects paths outside the selected project observation directory', async () => {
    const root = tempRoot();
    try {
      const outside = path.join(root, 'candidate.ir.json');
      fs.writeFileSync(outside, JSON.stringify(candidate()), 'utf8');
      await assert.rejects(promote(options(root, outside)), /observation directory/i);
      assert.equal(fs.existsSync(path.join(root, 'tests', 'e2e', 'generated')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects cross-project candidates and unresolved candidates without writing active files', async () => {
    const root = tempRoot();
    try {
      const wrongProject = writeCandidate(root, 'yuekai');
      await assert.rejects(promote(options(root, wrongProject)), /project/i);

      const unresolved = writeCandidate(root, 'caida', candidate(['ambiguous target']));
      await assert.rejects(promote(options(root, unresolved)), /unresolved/i);
      assert.equal(fs.existsSync(path.join(root, 'tests', 'e2e', 'generated')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('revalidates exact action targets against the current topology', async () => {
    const root = tempRoot();
    try {
      const file = writeCandidate(root);
      const graph = topology();
      graph.routes['/start'].elements = [];
      await assert.rejects(promote(options(root, file, { topology: graph })), /element|target/i);
      assert.equal(fs.existsSync(path.join(root, 'tests', 'e2e', 'generated')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes a byte-deterministic IR/spec pair from the validated candidate', async () => {
    const root = tempRoot();
    try {
      const file = writeCandidate(root);
      const result = await promote(options(root, file));
      const savedIr = JSON.parse(fs.readFileSync(result.irPath, 'utf8')) as StateTransitionIR;
      const savedSpec = fs.readFileSync(result.specPath, 'utf8');
      assert.equal(savedIr.flowId, 'flow_aabbccddee');
      assert.equal(savedSpec, emitSpec(savedIr, { mode: 'history', base: '/' }));
      assert.match(savedSpec, /getByRole\("button", \{ name: "Open", exact: true \}\)/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite an active flow', async () => {
    const root = tempRoot();
    try {
      const file = writeCandidate(root);
      const first = await promote(options(root, file));
      const originalSpec = fs.readFileSync(first.specPath, 'utf8');
      await assert.rejects(promote(options(root, file)), /already exists|overwrite/i);
      assert.equal(fs.readFileSync(first.specPath, 'utf8'), originalSpec);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('cleans a partially promoted IR when the second atomic rename fails', async () => {
    const root = tempRoot();
    try {
      const file = writeCandidate(root);
      let renames = 0;
      await assert.rejects(promote(options(root, file, {
        renameFile(source, target) {
          renames += 1;
          if (renames === 2) throw new Error('simulated spec rename failure');
          fs.renameSync(source, target);
        },
      })), /promotion failed/i);
      const generated = path.join(root, 'tests', 'e2e', 'generated');
      assert.deepEqual(fs.readdirSync(generated), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
