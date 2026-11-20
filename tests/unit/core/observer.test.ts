import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  observe,
  shouldBlockObservedRequest,
  type ObserveRuntimeFactory,
  type ObserveRuntimeSession,
} from '../../../src/idt/core/observer.js';
import { type ObservedElement } from '../../../src/idt/core/dom-observe.js';
import type { ProjectTopology } from '../../../src/idt/schemas/topology.schema.js';
import type { MidsceneAgentFactory } from '../../../src/idt/adapters/midscene-playwright.js';

function topology(): ProjectTopology {
  const elements = [
    { role: 'link' as const, name: 'Open details' },
  ];
  return {
    version: '1.0.0', project: 'caida', generatedAt: '', sourceDigest: 'a'.repeat(64),
    router: { mode: 'history', base: '/' },
    routes: {
      '/start': { path: '/start', filePath: 'fixture.vue', title: '', semanticKeywords: [], dynamicParams: [], transitions: [], elements },
      '/details': { path: '/details', filePath: 'details.vue', title: '', semanticKeywords: [], dynamicParams: [], transitions: [], elements },
    },
  };
}

const beforeElements: ObservedElement[] = [
  { tag: 'a', role: 'link', ownText: 'Open details', alt: null, css: 'a.open', visible: true },
];
const allowedClicks = [{ route: '/start', role: 'link', name: 'Open details' }];
const afterElements: ObservedElement[] = [
  ...beforeElements,
  { tag: 'div', role: 'dialog', ownText: 'Details', alt: null, css: 'div.details', visible: true },
];

function fakeRuntime(suffix = ''): { runtime: ObserveRuntimeFactory; state: { phase: number; hit: string | null; network: Array<{ method: string; url: string; status?: number }> } } {
  let currentUrl = '';
  const state = { phase: 0, hit: 'a.open' as string | null, network: [] as Array<{ method: string; url: string; status?: number }> };
  const page = {
    url: () => currentUrl,
    async goto(url: string) { currentUrl = new URL(url, 'http://127.0.0.1:8080').href + suffix; },
    async installProbe() {},
    async observe() { return state.phase === 0 ? beforeElements : afterElements; },
    async readHit() { const hit = state.hit; state.hit = null; return hit; },
    drainNetwork() { const events = state.network; state.network = []; return events; },
  };
  const session: ObserveRuntimeSession = { page, async close() {} };
  return {
    state,
    runtime: async () => session,
  };
}

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'idt-observe-'));
}

function factoryWithAction(
  actionName = 'tap',
  onBefore?: () => void,
  onAfter?: () => void,
): MidsceneAgentFactory {
  return (_page, options) => ({
    async aiAct() {
      onBefore?.();
      await options.beforeInvokeAction(actionName, {});
      onAfter?.();
      await options.afterInvokeAction(actionName, {});
      return 'not an oracle';
    },
    async destroy() {},
  });
}

describe('observe safety and artifact boundaries', () => {
  it('blocks mutations, cross-origin navigations, and data calls to unknown hosts', () => {
    assert.equal(shouldBlockObservedRequest({
      url: 'http://127.0.0.1:8080/api/order', baseOrigin: 'http://127.0.0.1:8080',
      method: 'POST', resourceType: 'fetch', isNavigation: false,
    }), true);
    assert.equal(shouldBlockObservedRequest({
      url: 'https://trade.example.com/prod', baseOrigin: 'http://127.0.0.1:8080',
      method: 'GET', resourceType: 'document', isNavigation: true,
    }), true);
    assert.equal(shouldBlockObservedRequest({
      url: 'https://api.example.com/data', baseOrigin: 'https://trade-uat.example.com',
      method: 'GET', resourceType: 'xhr', isNavigation: false,
    }), true);
    assert.equal(shouldBlockObservedRequest({
      url: 'https://cdn.example.com/app.css', baseOrigin: 'https://trade-uat.example.com',
      method: 'GET', resourceType: 'stylesheet', isNavigation: false,
    }), false);
    assert.equal(shouldBlockObservedRequest({
      url: 'https://api-uat.example.com/read', baseOrigin: 'https://trade-uat.example.com',
      method: 'GET', resourceType: 'fetch', isNavigation: false,
      networkAllowlist: [{ method: 'GET', url: 'https://api-uat.example.com/read' }],
    }), false);
    assert.equal(shouldBlockObservedRequest({
      url: 'https://api-uat.example.com/read/side-effect', baseOrigin: 'https://trade-uat.example.com',
      method: 'GET', resourceType: 'fetch', isNavigation: false,
      networkAllowlist: [{ method: 'GET', url: 'https://api-uat.example.com/read' }],
    }), true);
  });

  it('requires an explicit click target allowlist before opening a runtime', async () => {
    let opened = false;
    const root = tempRoot();
    try {
      await assert.rejects(observe({
        projectRoot: root, project: 'caida', route: '/start', intent: 'Open details',
        baseUrl: 'http://127.0.0.1:8080', topology: topology(), allowedActions: [],
        runtime: async () => { opened = true; throw new Error('must not open'); },
        agentFactory: factoryWithAction(),
      }), /explicit.*allowlist/i);
      assert.equal(opened, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects production URLs before opening a browser', async () => {
    let opened = false;
    const root = tempRoot();
    try {
      await assert.rejects(observe({
        projectRoot: root, project: 'caida', route: '/start', intent: 'Open details',
        baseUrl: 'https://trade.example.com', topology: topology(), allowedActions: allowedClicks,
        runtime: async () => { opened = true; throw new Error('must not launch'); },
        agentFactory: factoryWithAction(),
      }), /non-production|test environment/i);
      assert.equal(opened, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts explicit test-environment host labels and rejects production/credential variants', async () => {
    for (const baseUrl of [
      'https://trade.production-dev.example.com',
      'https://user:secret@127.0.0.1:8080',
    ]) {
      let opened = false;
      const root = tempRoot();
      try {
        await assert.rejects(observe({
          projectRoot: root, project: 'caida', route: '/start', intent: 'Open details',
          baseUrl, topology: topology(), allowedActions: allowedClicks, runtime: async () => { opened = true; throw new Error('must not launch'); },
          agentFactory: factoryWithAction(),
        }));
        assert.equal(opened, false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
    const root = tempRoot();
    try {
      await assert.doesNotReject(observe({
        projectRoot: root, project: 'caida', route: '/start', intent: 'Open details',
        baseUrl: 'https://trade-uat.example.com', topology: topology(), allowedActions: allowedClicks,
        runtime: fakeRuntime().runtime,
        agentFactory: () => ({ async aiAct() { return undefined; }, async destroy() {} }),
        outputRoot: path.join(root, '.idt', 'observations'),
      }));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects financial or state-changing intent before creating the agent', async () => {
    let agentCreated = false;
    const root = tempRoot();
    try {
      await assert.rejects(observe({
        projectRoot: root, project: 'caida', route: '/start', intent: '确认买入并提交订单',
        baseUrl: 'http://127.0.0.1:8080', topology: topology(), allowedActions: allowedClicks,
        runtime: fakeRuntime().runtime,
        agentFactory: () => { agentCreated = true; throw new Error('must not create'); },
      }), /risk|state-changing|financial/i);
      assert.equal(agentCreated, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires a Midscene model family before opening a browser when using the real adapter', async () => {
    let opened = false;
    const root = tempRoot();
    try {
      await assert.rejects(observe({
        projectRoot: root, project: 'caida', route: '/start', intent: 'Open details',
        baseUrl: 'http://127.0.0.1:8080', topology: topology(), allowedActions: allowedClicks,
        runtime: async () => { opened = true; throw new Error('must not open'); },
      }), /MIDSCENE_MODEL_FAMILY/);
      assert.equal(opened, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('stores IDT observation and candidate only under the ignored project observation directory', async () => {
    const root = tempRoot();
    const fake = fakeRuntime();
    const factory = factoryWithAction('tap', () => { fake.state.phase = 0; }, () => { fake.state.phase = 1; });
    try {
      const result = await observe({
        projectRoot: root, project: 'caida', route: '/start', intent: 'Open details',
        baseUrl: 'http://127.0.0.1:8080', topology: topology(), allowedActions: allowedClicks, runtime: fake.runtime,
        agentFactory: factory,
        outputRoot: path.join(root, '.idt', 'observations'),
      });
      assert.ok(result.outputDir.startsWith(path.join(root, '.idt', 'observations', 'caida') + path.sep));
      assert.ok(fs.existsSync(path.join(result.outputDir, 'observation.json')));
      assert.ok(fs.existsSync(path.join(result.outputDir, 'candidate.ir.json')));
      assert.ok(fs.existsSync(path.join(result.outputDir, 'report.html')));
      assert.match(fs.readFileSync(path.join(result.outputDir, 'report.html'), 'utf8'), /IDT Observation Report/);
      assert.ok(!fs.existsSync(path.join(root, 'tests', 'e2e', 'generated')));
      assert.equal(result.document.actions[0].targetRole, 'link');
      assert.equal(result.document.actions[0].targetName, 'Open details');
      assert.deepEqual(result.unresolved, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps actions without an exact observed target unresolved', async () => {
    const root = tempRoot();
    const fake = fakeRuntime();
    fake.state.hit = null;
    fake.state.phase = 1;
    const factory = factoryWithAction();
    try {
      const result = await observe({
        projectRoot: root, project: 'caida', route: '/start', intent: 'Open details',
        baseUrl: 'http://127.0.0.1:8080', topology: topology(), allowedActions: allowedClicks, runtime: fake.runtime,
        agentFactory: factory,
        outputRoot: path.join(root, '.idt', 'observations'),
      });
      assert.ok(result.unresolved.length > 0);
      assert.deepEqual(result.document.actions[0].targetRole, undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('maps a nested click hit to its nearest semantic ancestor', async () => {
    const root = tempRoot();
    const fake = fakeRuntime();
    fake.state.hit = 'a.open > span.label';
    fake.state.phase = 1;
    try {
      const result = await observe({
        projectRoot: root, project: 'caida', route: '/start', intent: 'Open details',
        baseUrl: 'http://127.0.0.1:8080', topology: topology(), allowedActions: allowedClicks, runtime: fake.runtime,
        agentFactory: factoryWithAction(),
        outputRoot: path.join(root, '.idt', 'observations'),
      });
      assert.equal(result.document.actions[0].targetRole, 'link');
      assert.equal(result.document.actions[0].targetName, 'Open details');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes the full browser page to Midscene when runtime supplies a separate page handle', async () => {
    const root = tempRoot();
    const fake = fakeRuntime();
    const fullPage = { url: () => 'http://127.0.0.1:8080/start', screenshot: async () => Buffer.from('') };
    const runtime: ObserveRuntimeFactory = async (opts) => ({
      ...await fake.runtime(opts),
      agentPage: fullPage,
    });
    let passedPage: unknown;
    try {
      await observe({
        projectRoot: root, project: 'caida', route: '/start', intent: 'Open details',
        baseUrl: 'http://127.0.0.1:8080', topology: topology(), allowedActions: allowedClicks, runtime,
        agentFactory: (agentPage) => {
          passedPage = agentPage;
          return { async aiAct() { return undefined; }, async destroy() {} };
        },
        outputRoot: path.join(root, '.idt', 'observations'),
      });
      assert.equal(passedPage, fullPage);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists redacted partial diagnostics when Midscene execution fails', async () => {
    const root = tempRoot();
    const fake = fakeRuntime();
    fake.state.phase = 1;
    const outputRoot = path.join(root, '.idt', 'observations');
    try {
      await assert.rejects(observe({
        projectRoot: root, project: 'caida', route: '/start', intent: 'Open details',
        baseUrl: 'http://127.0.0.1:8080', topology: topology(), allowedActions: allowedClicks, runtime: fake.runtime,
        outputRoot,
        agentFactory: (_page, callbacks) => ({
          async aiAct() {
            await callbacks.beforeInvokeAction('tap', {});
            await callbacks.afterInvokeAction('tap', {});
            throw new Error('Bearer secret-value-12345678');
          },
          async destroy() {},
        }),
      }), /redacted diagnostics saved/);

      const projectDir = path.join(outputRoot, 'caida');
      const runDir = fs.readdirSync(projectDir).map((name) => path.join(projectDir, name))[0];
      const serialized = fs.readFileSync(path.join(runDir, 'observation.json'), 'utf8');
      assert.match(serialized, /Observation failed \(unclassified\)/);
      assert.doesNotMatch(serialized, /secret-value|12345678/);
      assert.ok(fs.existsSync(path.join(runDir, 'candidate.ir.json')));
      const report = fs.readFileSync(path.join(runDir, 'report.html'), 'utf8');
      assert.doesNotMatch(report, /secret-value|12345678/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('redacts an unconfigured URL fragment and blocks the mismatched entry candidate', async () => {
    const root = tempRoot();
    const fake = fakeRuntime('#123456789012345678');
    fake.state.phase = 1;
    try {
      const result = await observe({
        projectRoot: root, project: 'caida', route: '/start', intent: 'Open details',
        baseUrl: 'http://127.0.0.1:8080', topology: topology(), allowedActions: allowedClicks, runtime: fake.runtime,
        agentFactory: factoryWithAction(),
        outputRoot: path.join(root, '.idt', 'observations'),
      });
      assert.doesNotMatch(JSON.stringify(result.document), /123456789012345678/);
      assert.ok(result.unresolved.some((item) => /fragment/i.test(item)));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes unconfigured query keys and values from persisted URL diagnostics', async () => {
    const root = tempRoot();
    const fake = fakeRuntime('?secret-account=account-ABC123456789');
    fake.state.phase = 1;
    try {
      const result = await observe({
        projectRoot: root, project: 'caida', route: '/start', intent: 'Open details',
        baseUrl: 'http://127.0.0.1:8080', topology: topology(), allowedActions: allowedClicks, runtime: fake.runtime,
        agentFactory: factoryWithAction(),
        outputRoot: path.join(root, '.idt', 'observations'),
      });
      const serialized = JSON.stringify(result.document);
      assert.doesNotMatch(serialized, /secret-account|account-ABC123456789/);
      assert.ok(result.unresolved.some((item) => /query data/i.test(item)));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('records only exact allowlisted GET evidence for the compiler', async () => {
    const root = tempRoot();
    const fake = fakeRuntime();
    const factory = factoryWithAction('tap', () => { fake.state.phase = 0; }, () => {
      fake.state.network = [{ method: 'GET', url: 'http://127.0.0.1:8080/api/read', status: 200 }];
    });
    const networkAllowlist = [{ method: 'GET' as const, url: 'http://127.0.0.1:8080/api/read' }];
    const graph = topology();
    try {
      const result = await observe({
        projectRoot: root, project: 'caida', route: '/start', intent: 'Open details',
        baseUrl: 'http://127.0.0.1:8080', topology: graph, allowedActions: allowedClicks,
        networkAllowlist, runtime: fake.runtime, agentFactory: factory,
        outputRoot: path.join(root, '.idt', 'observations'),
      });
      assert.deepEqual(result.document.actions[0].network, networkAllowlist.map((entry) => ({ ...entry, status: 200 })));
      assert.deepEqual(result.candidate.stages[0].invariants.network, [{
        method: 'GET', urlPattern: 'http://127.0.0.1:8080/api/read', exactUrl: 'http://127.0.0.1:8080/api/read',
        expectedStatus: 200, responseType: 'none',
      }]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('infers the text role for a clicked div with static text', async () => {
    const root = tempRoot();
    const topologyWithText: ProjectTopology = {
      ...topology(),
      routes: {
        ...topology().routes,
        '/start': {
          ...topology().routes['/start'],
          elements: [{ role: 'text', name: '动画' }],
        },
      },
    };
    const fake = fakeRuntime();
    fake.state.hit = 'div.animation-label';
    const originalRuntime = fake.runtime;
    const runtime: ObserveRuntimeFactory = async (options) => {
      const session = await originalRuntime(options);
      return {
        ...session,
        page: {
          ...session.page,
          async observe() {
            const animation = { tag: 'div', role: null, ownText: '动画', alt: null, css: 'div.animation-label', visible: true };
            return fake.state.phase === 0
              ? [animation]
              : [animation, { tag: 'div', role: 'dialog', ownText: '动画预览', alt: null, css: 'div.preview', visible: true }];
          },
        },
      };
    };
    try {
      const result = await observe({
        projectRoot: root, project: 'caida', route: '/start', intent: '点击动画',
        baseUrl: 'http://127.0.0.1:8080', topology: topologyWithText,
        allowedActions: [{ route: '/start', role: 'text', name: '动画' }], runtime,
        agentFactory: factoryWithAction('tap', () => { fake.state.phase = 0; }, () => { fake.state.phase = 1; }),
        outputRoot: path.join(root, '.idt', 'observations'),
      });
      assert.equal(result.document.actions[0].targetRole, 'text');
      assert.equal(result.document.actions[0].targetName, '动画');
      assert.deepEqual(result.unresolved, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('classifies action guard rejection as action_guard_rejected', async () => {
    const root = tempRoot();
    const fake = fakeRuntime();
    const runtime: ObserveRuntimeFactory = async (options) => {
      const session = await fake.runtime(options);
      return {
        ...session,
        page: {
          ...session.page,
          async readBlockedSecurityEvent() {
            return {
              type: 'action_guard_rejected',
              message: 'IDT observe blocked an unapproved or risky control "继续" (button) (action_guard_rejected)',
              targetRole: 'button',
              targetName: '继续',
            };
          },
        },
      };
    };
    try {
      await assert.rejects(observe({
        projectRoot: root, project: 'caida', route: '/start', intent: '点击未授权按钮',
        baseUrl: 'http://127.0.0.1:8080', topology: topology(),
        allowedActions: allowedClicks, runtime,
        agentFactory: factoryWithAction(),
        outputRoot: path.join(root, '.idt', 'observations'),
      }), /redacted diagnostics saved/);
      const projectDir = path.join(root, '.idt', 'observations', 'caida');
      const runDir = fs.readdirSync(projectDir).map((name) => path.join(projectDir, name))[0];
      const serialized = fs.readFileSync(path.join(runDir, 'observation.json'), 'utf8');
      assert.match(serialized, /Observation failed \(action_guard_rejected\)/);
      assert.match(serialized, /action_guard_rejected: IDT observe blocked an unapproved or risky control/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('classifies cross-origin navigation blocking as navigation_blocked', async () => {
    const root = tempRoot();
    const fake = fakeRuntime();
    const runtime: ObserveRuntimeFactory = async (options) => {
      const session = await fake.runtime(options);
      return {
        ...session,
        page: {
          ...session.page,
          async readBlockedSecurityEvent() {
            return {
              type: 'navigation_blocked',
              message: 'IDT observe blocked an external or cross-origin navigation to https://external.example.com/info (navigation_blocked)',
              url: 'https://external.example.com/info',
            };
          },
        },
      };
    };
    try {
      await assert.rejects(observe({
        projectRoot: root, project: 'caida', route: '/start', intent: '打开外部链接',
        baseUrl: 'http://127.0.0.1:8080', topology: topology(),
        allowedActions: allowedClicks, runtime,
        agentFactory: factoryWithAction(),
        outputRoot: path.join(root, '.idt', 'observations'),
      }), /redacted diagnostics saved/);
      const projectDir = path.join(root, '.idt', 'observations', 'caida');
      const runDir = fs.readdirSync(projectDir).map((name) => path.join(projectDir, name))[0];
      const serialized = fs.readFileSync(path.join(runDir, 'observation.json'), 'utf8');
      assert.match(serialized, /Observation failed \(navigation_blocked\)/);
      assert.match(serialized, /navigation_blocked: IDT observe blocked an external or cross-origin navigation/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('classifies unapproved data requests as network_guard_rejected', async () => {
    const root = tempRoot();
    const fake = fakeRuntime();
    const runtime: ObserveRuntimeFactory = async (options) => {
      const session = await fake.runtime(options);
      return {
        ...session,
        page: {
          ...session.page,
          async readBlockedSecurityEvent() {
            return {
              type: 'network_guard_rejected',
              message: 'IDT observe blocked an unapproved network request POST http://127.0.0.1:8080/api/save (network_guard_rejected)',
              method: 'POST',
              url: 'http://127.0.0.1:8080/api/save',
            };
          },
        },
      };
    };
    try {
      await assert.rejects(observe({
        projectRoot: root, project: 'caida', route: '/start', intent: '触发网络请求',
        baseUrl: 'http://127.0.0.1:8080', topology: topology(),
        allowedActions: allowedClicks, runtime,
        agentFactory: factoryWithAction(),
        outputRoot: path.join(root, '.idt', 'observations'),
      }), /redacted diagnostics saved/);
      const projectDir = path.join(root, '.idt', 'observations', 'caida');
      const runDir = fs.readdirSync(projectDir).map((name) => path.join(projectDir, name))[0];
      const serialized = fs.readFileSync(path.join(runDir, 'observation.json'), 'utf8');
      assert.match(serialized, /Observation failed \(network_guard_rejected\)/);
      assert.match(serialized, /network_guard_rejected: IDT observe blocked an unapproved network request/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('records provider_status as success on successful execution', async () => {
    const root = tempRoot();
    const fake = fakeRuntime();
    const factory = factoryWithAction('tap', () => { fake.state.phase = 0; }, () => { fake.state.phase = 1; });
    try {
      const result = await observe({
        projectRoot: root, project: 'caida', route: '/start', intent: 'Open details',
        baseUrl: 'http://127.0.0.1:8080', topology: topology(), allowedActions: allowedClicks, runtime: fake.runtime,
        agentFactory: factory,
        outputRoot: path.join(root, '.idt', 'observations'),
      });
      assert.equal(result.document.provider_status, 'success');
      const serialized = fs.readFileSync(path.join(result.outputDir, 'observation.json'), 'utf8');
      assert.match(serialized, /"provider_status":\s*"success"/);
      const report = fs.readFileSync(path.join(result.outputDir, 'report.html'), 'utf8');
      assert.match(report, /Provider 状态<\/dt><dd>success<\/dd>/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('records provider_status as timeout when Midscene execution exceeds timeoutMs', async () => {
    const root = tempRoot();
    const fake = fakeRuntime();
    const slowFactory: MidsceneAgentFactory = () => ({
      async aiAct() {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return 'delayed';
      },
      async destroy() {},
    });
    try {
      await assert.rejects(observe({
        projectRoot: root, project: 'caida', route: '/start', intent: 'Open details',
        baseUrl: 'http://127.0.0.1:8080', topology: topology(), allowedActions: allowedClicks, runtime: fake.runtime,
        agentFactory: slowFactory,
        timeoutMs: 20,
        outputRoot: path.join(root, '.idt', 'observations'),
      }), /redacted diagnostics saved/);
      const projectDir = path.join(root, '.idt', 'observations', 'caida');
      const runDir = fs.readdirSync(projectDir).map((name) => path.join(projectDir, name))[0];
      const serialized = fs.readFileSync(path.join(runDir, 'observation.json'), 'utf8');
      assert.match(serialized, /"provider_status":\s*"timeout"/);
      assert.match(serialized, /Observation failed \(model-timeout\)/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('records provider_status as error when provider fails', async () => {
    const root = tempRoot();
    const fake = fakeRuntime();
    const failingFactory: MidsceneAgentFactory = () => ({
      async aiAct() {
        throw new Error('500 internal server error upstream');
      },
      async destroy() {},
    });
    try {
      await assert.rejects(observe({
        projectRoot: root, project: 'caida', route: '/start', intent: 'Open details',
        baseUrl: 'http://127.0.0.1:8080', topology: topology(), allowedActions: allowedClicks, runtime: fake.runtime,
        agentFactory: failingFactory,
        outputRoot: path.join(root, '.idt', 'observations'),
      }), /redacted diagnostics saved/);
      const projectDir = path.join(root, '.idt', 'observations', 'caida');
      const runDir = fs.readdirSync(projectDir).map((name) => path.join(projectDir, name))[0];
      const serialized = fs.readFileSync(path.join(runDir, 'observation.json'), 'utf8');
      assert.match(serialized, /"provider_status":\s*"error"/);
      assert.match(serialized, /Observation failed \(model-provider\)/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
