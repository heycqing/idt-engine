import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { observe } from '../../../src/idt/core/observer.js';
import { promote } from '../../../src/idt/core/promoter.js';
import { runPlaywrightSpec } from '../../../src/idt/core/runner.js';
import { writeProjectPlaywrightConfig } from '../../../src/idt/core/playwright-config.js';
import type { IdtProject } from '../../../src/idt/config/projects.js';
import type { ProjectTopology } from '../../../src/idt/schemas/topology.schema.js';
import type { MidsceneAgentFactory } from '../../../src/idt/adapters/midscene-playwright.js';

function topology(): ProjectTopology {
  return {
    version: '1.0.0', project: 'fixture', generatedAt: '', sourceDigest: 'b'.repeat(64),
    router: { mode: 'history', base: '/' },
    routes: {
      '/start': {
        path: '/start', filePath: 'start.vue', title: '', semanticKeywords: [], dynamicParams: [], transitions: [],
        elements: [{ role: 'link', name: 'Open details' }],
      },
      '/details': {
        path: '/details', filePath: 'details.vue', title: '', semanticKeywords: [], dynamicParams: [], transitions: [],
        elements: [],
      },
    },
  };
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server did not bind a TCP port');
  return `http://127.0.0.1:${address.port}`;
}

describe('IDT observe → promote → deterministic Playwright main flow', () => {
  it('promotes only the observed route evidence and runs the emitted spec three times', async () => {
    let linkLabel = 'Open details';
    const server = http.createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      if (request.url === '/details') {
        response.end('<!doctype html><html><body><h1>Details</h1></body></html>');
      } else {
        response.end(`<!doctype html><html><body><a id="open-details" href="/details">${linkLabel}</a></body></html>`);
      }
    });
    const baseUrl = await listen(server);
    const projectRoot = fs.mkdtempSync(path.resolve(process.cwd(), '..', '.idt-observe-main-flow-'));
    const previousBaseUrl = process.env.IDT_BASE_URL;
    process.env.IDT_BASE_URL = baseUrl;

    try {
      const project: IdtProject = {
        name: 'fixture', root: projectRoot, implicit: false,
        pageGlobs: [], routerGlobs: [], localeFiles: [], deferredContainers: [], port: 3000,
      };
      writeProjectPlaywrightConfig(project);
      const graph = topology();
      const agentFactory: MidsceneAgentFactory = (rawPage, callbacks) => ({
        async aiAct() {
          await callbacks.beforeInvokeAction('tap', { description: 'Open details' });
          await (rawPage as Page).getByRole('link', { name: 'Open details', exact: true }).click();
          await callbacks.afterInvokeAction('tap', { description: 'Open details' });
          return undefined;
        },
        async destroy() {},
      });

      const observation = await observe({
        projectRoot, project, route: '/start', intent: 'Open details', baseUrl,
        topology: graph,
        allowedActions: [{ route: '/start', role: 'link', name: 'Open details' }],
        agentFactory,
      });
      assert.deepEqual(observation.unresolved, [], JSON.stringify(observation.document.actions[0]));
      assert.equal(observation.candidate.stages[0].invariants.routeGuard?.targetUrlPattern, '^/details$');

      const promoted = await promote({
        projectRoot, project, candidatePath: path.join(observation.outputDir, 'candidate.ir.json'),
        topology: graph, router: { mode: 'history', base: '/' },
      });
      const initialSpec = fs.readFileSync(promoted.specPath, 'utf8');
      const secondEmit = await import('../../../src/idt/core/emitter.js').then(({ emitSpec }) =>
        emitSpec(JSON.parse(fs.readFileSync(promoted.irPath, 'utf8')), { mode: 'history', base: '/' }),
      );
      assert.equal(secondEmit, initialSpec);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = await runPlaywrightSpec(path.relative(projectRoot, promoted.specPath), projectRoot);
        assert.equal(result.exitCode, 0, `deterministic replay ${attempt + 1} failed: ${JSON.stringify(result.report)}`);
      }

      linkLabel = 'Changed label';
      const mutated = await runPlaywrightSpec(path.relative(projectRoot, promoted.specPath), projectRoot);
      assert.equal(mutated.exitCode, 1, 'exact locator must fail after target label mutation');
      linkLabel = 'Open details';
      const restored = await runPlaywrightSpec(path.relative(projectRoot, promoted.specPath), projectRoot);
      assert.equal(restored.exitCode, 0, 'spec must pass after the target label is restored');
    } finally {
      if (previousBaseUrl === undefined) delete process.env.IDT_BASE_URL;
      else process.env.IDT_BASE_URL = previousBaseUrl;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
