import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { compileObservation } from '../../../src/idt/core/observation-compiler.js';
import {
  ObservedActionSchema,
  ObservationDocumentSchema,
  ObservationCandidateSchema,
  type ObservedAction,
  type ObservationDocument,
} from '../../../src/idt/core/observation-schema.js';
import type { ProjectTopology } from '../../../src/idt/schemas/topology.schema.js';
import { emitSpec } from '../../../src/idt/core/emitter.js';
import type { RouterUrlOptions } from '../../../src/idt/core/route-url.js';
import { NetworkInvariantSchema } from '../../../src/idt/core/ir-schema.js';

function topology(): ProjectTopology {
  const route = (path: string) => ({
    path, filePath: 'fixture.vue', title: '', semanticKeywords: [],
    dynamicParams: [], transitions: [],
    elements: [
      { role: 'button' as const, name: 'Open' },
      { role: 'textbox' as const, name: 'Search' },
      { role: 'combobox' as const, name: 'Category' },
      { role: 'checkbox' as const, name: 'Enabled' },
    ],
  });
  return {
    version: '1.0.0', project: 'fixture', generatedAt: '', sourceDigest: 'a'.repeat(64),
    routes: { '/start': route('/start'), '/next': route('/next') },
  };
}

function action(overrides: Partial<ObservedAction> = {}): ObservedAction {
  return {
    sequence: 0, sourceType: 'click', description: 'Open details',
    beforeUrl: 'http://fixture.test/start', afterUrl: 'http://fixture.test/next',
    targetRole: 'button', targetName: 'Open', hitSelector: '#open',
    appearedElements: [], network: [], unresolved: [], ...overrides,
  };
}

function document(actions = [action()]): ObservationDocument {
  return {
    schemaVersion: 1, project: 'fixture', route: '/start', intent: 'Open details',
    createdAt: '2026-11-02T00:00:00.000Z', actions, unresolved: [],
  };
}

function compile(actions = [action()], graph = topology()) {
  return compileObservation({ document: document(actions), topology: graph });
}

describe('observation schemas', () => {
  it('rejects unowned fields instead of retaining raw model/network records', () => {
    assert.equal(ObservationDocumentSchema.safeParse(document()).success, true);
    assert.equal(ObservedActionSchema.safeParse({ ...action(), rawPlan: {} }).success, false);
    assert.equal(ObservedActionSchema.safeParse(action({
      network: [{ method: 'GET', url: '/read', headers: { authorization: 'secret' } } as never],
    })).success, false);
    assert.equal(ObservationDocumentSchema.safeParse({ ...document(), token: 'secret' }).success, false);
  });

  it('rejects invalid sequence, status, timestamp, and empty metadata', () => {
    assert.equal(ObservedActionSchema.safeParse(action({ sequence: -1 })).success, false);
    assert.equal(ObservedActionSchema.safeParse(action({ network: [{ method: 'GET', url: '/read', status: 900 }] })).success, false);
    assert.equal(ObservationDocumentSchema.safeParse({ ...document(), createdAt: 'yesterday' }).success, false);
    assert.equal(ObservationDocumentSchema.safeParse({ ...document(), project: '' }).success, false);
  });

  it('rejects unknown candidate fields at the action and invariant boundaries', () => {
    const { candidate } = compile();
    assert.equal(ObservationCandidateSchema.safeParse(candidate).success, true);
    const bad = structuredClone(candidate);
    (bad.stages[0].actions[0] as any).selector = '#open';
    assert.equal(ObservationCandidateSchema.safeParse(bad).success, false);
    const other = structuredClone(candidate);
    (other.stages[0].invariants as any).aiAssert = 'done';
    assert.equal(ObservationCandidateSchema.safeParse(other).success, false);
  });

  it('accepts an optional exact network URL and rejects a malformed one', () => {
    const network = { method: 'GET', urlPattern: '/api/details', exactUrl: 'http://fixture.test/api/details' };
    assert.equal(NetworkInvariantSchema.parse(network).exactUrl, 'http://fixture.test/api/details');
    assert.equal(NetworkInvariantSchema.safeParse({ ...network, exactUrl: 'not a URL' }).success, false);
  });
});

describe('compileObservation action mapping', () => {
  for (const [sourceType, targetRole, targetName, inputValue, expected] of [
    ['click', 'button', 'Open', undefined, 'CLICK'],
    ['input', 'textbox', 'Search', '', 'FILL'],
    ['fill', 'textbox', 'Search', 'example', 'FILL'],
    ['select', 'combobox', 'Category', 'one', 'SELECT'],
    ['check', 'checkbox', 'Enabled', undefined, 'CHECK'],
  ] as const) {
    it(`maps ${sourceType} to ${expected} using the exact semantic target`, () => {
      const { candidate, unresolved } = compile([action({ sourceType, targetRole, targetName, inputValue })]);
      assert.deepEqual(unresolved, []);
      assert.deepEqual(candidate.stages[0].actions[0], {
        actionType: expected, targetRole, targetName,
        ...(inputValue !== undefined ? { inputValue } : {}),
        timeoutMs: 5000, triggersRequest: false,
      });
      assert.match(emitSpec(candidate), /exact: true/);
    });
  }

  for (const sourceType of ['scroll', 'hover', 'drag', 'key-chord', 'uncheck']) {
    it(`keeps ${sourceType} unresolved without fabricating a runnable action`, () => {
      const { candidate, unresolved } = compile([action({ sourceType })]);
      assert.deepEqual(candidate.stages[0].actions, []);
      assert.ok(unresolved.some((item) => item.includes(sourceType)));
      assert.deepEqual(candidate.unresolved, unresolved);
      assert.throws(() => emitSpec(candidate), /unresolved/i);
    });
  }

  it('does not turn a missing fill value into an empty string', () => {
    const { candidate, unresolved } = compile([action({ sourceType: 'fill', targetRole: 'textbox', targetName: 'Search' })]);
    assert.ok(unresolved.some((item) => /inputValue/.test(item)));
    assert.deepEqual(candidate.stages[0].actions, []);
  });

  it('retains document and action unresolved items so hard evidence cannot erase them', () => {
    const doc = document([action({ unresolved: ['adapter could not verify hit target'] })]);
    doc.unresolved = ['report incomplete'];
    const result = compileObservation({ document: doc, topology: topology() });
    assert.ok(result.unresolved.includes('report incomplete'));
    assert.ok(result.unresolved.some((item) => item.includes('adapter could not verify hit target')));
    assert.throws(() => emitSpec(result.candidate), /unresolved/i);
  });
});

describe('compileObservation evidence', () => {
  const appeared = [{ role: 'dialog', name: 'Details', selector: '#details' }];
  const network = [{ method: 'GET', url: 'http://fixture.test/api/details', status: 200 }];
  const networkAllowlist = [{ method: 'GET' as const, url: 'http://fixture.test/api/details' }];

  it('prefers real route navigation over DOM and approved network evidence', () => {
    const { candidate, unresolved } = compileObservation({
      document: document([action({ appearedElements: appeared, network })]), topology: topology(), networkAllowlist,
    });
    assert.deepEqual(unresolved, []);
    assert.deepEqual(candidate.stages[0].invariants.network, []);
    assert.equal(candidate.stages[0].invariants.domDelta, undefined);
    assert.ok(candidate.stages[0].invariants.routeGuard);
  });

  it('prefers a unique semantic DOM appearance over approved network evidence', () => {
    const { candidate, unresolved } = compileObservation({
      document: document([action({ afterUrl: 'http://fixture.test/start', appearedElements: appeared, network })]), topology: topology(), networkAllowlist,
    });
    assert.deepEqual(unresolved, []);
    assert.deepEqual(candidate.stages[0].invariants, { network: [], domDelta: { appearedRole: 'dialog', appearedName: 'Details' } });
    assert.match(emitSpec(candidate), /getByRole\("dialog", \{ name: "Details", exact: true \}\)/);
  });

  it('records the exact allowlisted network URL for the emitter equality check', () => {
    const { candidate, unresolved } = compileObservation({
      document: document([action({ afterUrl: 'http://fixture.test/start', network })]), topology: topology(), networkAllowlist,
    });
    assert.deepEqual(unresolved, []);
    assert.deepEqual(candidate.stages[0].invariants.network, [{
      method: 'GET', urlPattern: 'http://fixture.test/api/details', exactUrl: 'http://fixture.test/api/details', expectedStatus: 200, responseType: 'none',
    }]);
    assert.equal(candidate.stages[0].actions[0].triggersRequest, true);
  });

  it('does not let allowlisted network evidence override ambiguous semantic DOM appearances', () => {
    for (const appearedElements of [[...appeared, ...appeared], [...appeared, { role: 'alert', name: 'Complete' }]]) {
      const result = compileObservation({
        document: document([action({ afterUrl: 'http://fixture.test/start', appearedElements, network })]), topology: topology(), networkAllowlist,
      });
      assert.ok(result.unresolved.some((item) => /ambiguous.*evidence/i.test(item)));
      assert.deepEqual(result.candidate.stages[0].invariants, { network: [] });
      assert.throws(() => emitSpec(result.candidate), /unresolved/i);
    }
  });

  for (const change of [
    { network },
    { appearedElements: [...appeared, ...appeared] },
    { appearedElements: [...appeared, { role: 'alert', name: 'Complete' }] },
    { appearedElements: [{ selector: '#details', text: 'Details' }] },
    {},
  ]) {
    it(`blocks absent or ambiguous hard evidence: ${JSON.stringify(change)}`, () => {
      const { candidate, unresolved } = compile([action({ afterUrl: 'http://fixture.test/start', ...change })]);
      assert.ok(unresolved.some((item) => /evidence/i.test(item)));
      assert.throws(() => emitSpec(candidate), /unresolved/i);
    });
  }

  it('does not accept an allowlist URL prefix, a missing status, or a write request', () => {
    for (const observed of [
      { method: 'GET', url: 'http://fixture.test/api/details/other', status: 200 },
      { method: 'GET', url: 'http://fixture.test/api/details' },
      { method: 'POST', url: 'http://fixture.test/api/details', status: 200 },
    ]) {
      const result = compileObservation({
        document: document([action({ afterUrl: 'http://fixture.test/start', network: [observed] })]), topology: topology(), networkAllowlist,
      });
      assert.ok(result.unresolved.length > 0);
      assert.deepEqual(result.candidate.stages[0].invariants.network, []);
    }
  });

  it('handles hash routes and ignores query-only changes as navigation evidence', () => {
    const graph = topology();
    graph.router = { mode: 'hash', base: '/app/', query: { channel: 'test' } };
    const result = compile([action({ beforeUrl: 'http://fixture.test/app/#/start?channel=test', afterUrl: 'http://fixture.test/app/#/next?channel=test' })], graph);
    assert.deepEqual(result.unresolved, []);
    assert.equal(result.candidate.stages[0].routePattern, '/start');
    assert.ok(result.candidate.stages[0].invariants.routeGuard);
    const queryOnly = compile([action({ beforeUrl: 'http://fixture.test/app/#/start?channel=test', afterUrl: 'http://fixture.test/app/#/start?channel=other' })], graph);
    assert.ok(queryOnly.unresolved.some((item) => /evidence/i.test(item)));
  });

  it('blocks unknown routes and cross-origin navigation', () => {
    for (const afterUrl of ['http://fixture.test/unknown', 'http://external.test/next']) {
      const result = compile([action({ afterUrl })]);
      assert.ok(result.unresolved.length > 0);
      assert.throws(() => emitSpec(result.candidate), /unresolved/i);
    }
  });

  for (const targetRoute of ['/result%20name', `/${'a'.repeat(201)}`]) {
    it(`keeps a navigation pattern outside SafePattern unresolved: ${targetRoute.slice(0, 30)}`, () => {
      const graph = topology();
      graph.routes[targetRoute] = { ...graph.routes['/next'], path: targetRoute };
      const result = compile([action({ afterUrl: `http://fixture.test${targetRoute}` })], graph);
      assert.ok(result.unresolved.some((item) => /route.*pattern/i.test(item)));
      assert.deepEqual(result.candidate.stages[0].invariants, { network: [] });
      assert.throws(() => emitSpec(result.candidate), /unresolved/i);
    });
  }

  it('keeps colon routes unresolved because the current emitter treats them as dynamic parameters', () => {
    const graph = topology();
    graph.routes['/account:cash'] = { ...graph.routes['/next'], path: '/account:cash' };
    const result = compile([action({ afterUrl: 'http://fixture.test/account:cash' })], graph);

    assert.ok(result.unresolved.some((item) => /dynamic.*route|route.*dynamic/i.test(item)));
    assert.throws(() => emitSpec(result.candidate), /unresolved/i);
  });
});

describe('exact network evidence in emitted Playwright code', () => {
  for (const exact of [true, false]) {
    it(`${exact ? 'rejects' : 'retains legacy matching for'} query and suffix URLs`, async () => {
      const { candidate } = compile();
      const exactUrl = 'http://fixture.test/api/details';
      candidate.stages[0].invariants = { network: [{
        method: 'GET', urlPattern: exactUrl,
        ...(exact ? { exactUrl } : {}),
        expectedStatus: 200, responseType: 'none',
      }] };
      candidate.stages[0].actions[0].triggersRequest = true;
      let verdict: Promise<void> | undefined;
      let predicatesChecked = 0;
      const page = {
        async goto() {},
        getByRole() { return { async click() {} }; },
        async waitForResponse(predicate: (response: any) => boolean) {
          const response = (url: string, method = 'GET') => ({ url: () => url, request: () => ({ method: () => method }) });
          assert.equal(predicate(response(exactUrl)), true);
          assert.equal(predicate(response(`${exactUrl}/other`)), !exact);
          assert.equal(predicate(response(`${exactUrl}?other=true`)), !exact);
          assert.equal(predicate(response(exactUrl, 'POST')), false);
          predicatesChecked++;
          return { status: () => 200 };
        },
      };
      runInNewContext(emitSpec(candidate).replace(/^import .*?;\r?\n/m, ''), {
        test(_name: string, body: (fixtures: { page: typeof page }) => Promise<void>) { verdict = body({ page }); },
        expect(value: unknown) { return { toBe(expected: unknown) { assert.equal(value, expected); } }; },
      });
      assert.ok(verdict);
      await verdict;
      assert.equal(predicatesChecked, 1);
    });
  }
});

describe('compiled route guards in emitted Playwright code', () => {
  for (const [router, beforeUrl, afterUrl, initialRoute = '/start'] of [
    [{ mode: 'history' }, 'http://fixture.test/start', 'http://fixture.test/next'],
    [{ mode: 'history', base: '/app/' }, 'http://fixture.test/app/start', 'http://fixture.test/app/next'],
    [{ mode: 'history', base: '/app/', query: { channel: 'test' } }, 'http://fixture.test/app/start?channel=test', 'http://fixture.test/app/next?channel=test'],
    [{ mode: 'hash' }, 'http://fixture.test/#/start', 'http://fixture.test/#/next'],
    [{ mode: 'hash', base: '/app/', query: { channel: 'test' } }, 'http://fixture.test/app/#/start?channel=test', 'http://fixture.test/app/#/next?channel=test'],
    [{ mode: 'history' }, 'http://fixture.test/start', 'http://fixture.test/next?id=1'],
    [{ mode: 'history' }, 'http://fixture.test/start', 'http://fixture.test/next#section'],
    [{ mode: 'history', base: '/app/' }, 'http://fixture.test/app/start', 'http://fixture.test/app/next?id=1#section'],
    [{ mode: 'hash' }, 'http://fixture.test/#/start', 'http://fixture.test/#/next?id=1'],
    [{ mode: 'hash' }, 'http://fixture.test/#/start', 'http://fixture.test/#/next#section'],
    [{ mode: 'hash', base: '/app/' }, 'http://fixture.test/app/#/start', 'http://fixture.test/app/?outer=test#/next?id=1#section'],
    [{ mode: 'history' }, 'http://fixture.test/foo/next', 'http://fixture.test/next', '/foo/next'],
    [{ mode: 'history', base: '/app/' }, 'http://fixture.test/app/foo/next', 'http://fixture.test/app/next', '/foo/next'],
    [{ mode: 'hash', base: '/app/' }, 'http://fixture.test/app/#/foo/next', 'http://fixture.test/app/#/next', '/foo/next'],
  ] satisfies Array<[RouterUrlOptions, string, string, string?]>) {
    it(`waits for the actual full browser URL in ${JSON.stringify(router)}`, async () => {
      const graph = topology();
      graph.router = router;
      graph.routes[initialRoute] = { ...graph.routes['/start'], path: initialRoute };
      const doc = document([action({ beforeUrl, afterUrl })]);
      doc.route = initialRoute;
      const { candidate, unresolved } = compileObservation({ document: doc, topology: graph });
      assert.deepEqual(unresolved, []);
      let currentUrl = '';
      let verdict: Promise<void> | undefined;
      let assertions = 0;
      const assertUrl = (pattern: RegExp) => {
        assert.equal(pattern.test(currentUrl), true, `${pattern} must match ${currentUrl}`);
        assert.equal(pattern.test(beforeUrl), false);
        assert.equal(pattern.test(afterUrl.replace('/next', '/next-more')), false);
        assertions++;
      };
      const page = {
        async goto(path: string) {
          currentUrl = new URL(path, 'http://fixture.test').href;
          assert.equal(currentUrl, beforeUrl);
        },
        getByRole(role: string, options: { name: string; exact: boolean }) {
          assert.equal(role, 'button');
          assert.equal(options.name, 'Open');
          assert.equal(options.exact, true);
          return { async click() { currentUrl = afterUrl; } };
        },
        async waitForURL(pattern: RegExp) { assertUrl(pattern); },
      };
      const source = emitSpec(candidate, router).replace(/^import .*?;\r?\n/m, '');
      runInNewContext(source, {
        test(_name: string, body: (fixtures: { page: typeof page }) => Promise<void>) { verdict = body({ page }); },
        expect(actual: unknown) {
          assert.equal(actual, page);
          return { async toHaveURL(pattern: RegExp) { assertUrl(pattern); } };
        },
      });
      assert.ok(verdict);
      await verdict;
      assert.equal(assertions, 2);
    });
  }
});

describe('compileObservation target and sequence safety', () => {
  for (const [router, beforeUrl] of [
    [{ mode: 'history' }, 'http://fixture.test/start?account=credit'],
    [{ mode: 'history' }, 'http://fixture.test/start#credit'],
    [{ mode: 'hash' }, 'http://fixture.test/?account=credit#/start'],
    [{ mode: 'hash' }, 'http://fixture.test/#/start?account=credit'],
    [{ mode: 'hash' }, 'http://fixture.test/#/start#credit'],
    [{ mode: 'history', base: '/app/', query: { channel: 'test' } }, 'http://fixture.test/app/start'],
    [{ mode: 'hash', base: '/app/', query: { channel: 'test' } }, 'http://fixture.test/app/#/start?channel=test&account=credit'],
  ] satisfies Array<[RouterUrlOptions, string]>) {
    it(`rejects an entry URL differing from deterministic goto: ${beforeUrl}`, () => {
      const graph = topology();
      graph.router = router;
      const result = compile([action({ beforeUrl, afterUrl: beforeUrl, appearedElements: [{ role: 'dialog', name: 'Details' }] })], graph);
      assert.ok(result.unresolved.some((item) => /initial.*url/i.test(item)));
      assert.throws(() => emitSpec(result.candidate, router), /unresolved/i);
    });
  }

  it('does not fabricate navigation evidence when a click stays on a suffix-collision route', () => {
    const graph = topology();
    graph.routes['/foo/next'] = { ...graph.routes['/start'], path: '/foo/next' };
    const doc = document([action({ beforeUrl: 'http://fixture.test/foo/next', afterUrl: 'http://fixture.test/foo/next' })]);
    doc.route = '/foo/next';
    const result = compileObservation({ document: doc, topology: graph });
    assert.ok(result.unresolved.some((item) => /evidence/i.test(item)));
    assert.equal(result.candidate.stages[0].invariants.routeGuard, undefined);
    assert.throws(() => emitSpec(result.candidate), /unresolved/i);
  });

  it('rejects a hit selector without an exact role and name', () => {
    const result = compile([action({ targetRole: undefined, targetName: undefined })]);
    assert.deepEqual(result.candidate.stages[0].actions, []);
    assert.ok(result.unresolved.some((item) => /locator/i.test(item)));
    assert.throws(() => emitSpec(result.candidate), /unresolved/i);
  });

  it('rejects duplicate, missing, dynamic, and data-dependent semantic targets', () => {
    for (const elements of [
      [{ role: 'button' as const, name: 'Open' }, { role: 'button' as const, name: 'Open' }],
      [],
      [{ role: 'button' as const, name: 'Open', dynamic: true as const }],
      [{ role: 'button' as const, name: 'Open', dataScoped: true as const }],
    ]) {
      const graph = topology();
      graph.routes['/start'].elements = elements;
      const result = compile([action()], graph);
      assert.deepEqual(result.candidate.stages[0].actions, []);
      assert.ok(result.unresolved.some((item) => /locator/i.test(item)));
    }
  });

  it('keeps actions in observation order in separate evidence stages', () => {
    const result = compile([
      action(),
      action({ sequence: 1, beforeUrl: 'http://fixture.test/next', afterUrl: 'http://fixture.test/next', appearedElements: [{ role: 'dialog', name: 'Details' }] }),
    ]);
    assert.deepEqual(result.unresolved, []);
    assert.deepEqual(result.candidate.stages.map((stage) => [stage.stageIndex, stage.routePattern]), [[0, '/start'], [1, '/next']]);
    assert.equal(result.candidate.stages[1].actions[0].targetName, 'Open');
  });

  for (const beforeUrl of [
    'http://other.test/next',
    'https://fixture.test/next',
    'http://fixture.test:8080/next',
    'http://fixture.test/next?changed=true',
    'http://fixture.test/next#changed',
  ]) {
    it(`rejects a subsequent action whose full before URL is disconnected: ${beforeUrl}`, () => {
      const result = compile([
        action(),
        action({ sequence: 1, beforeUrl, afterUrl: beforeUrl, appearedElements: [{ role: 'dialog', name: 'Details' }] }),
      ]);
      assert.ok(result.unresolved.some((item) => /url.*disconnected/i.test(item)));
      assert.throws(() => emitSpec(result.candidate), /unresolved/i);
    });
  }

  it('blocks empty, out-of-order, disconnected, and cross-project observations', () => {
    const graph = topology();
    for (const doc of [
      document([]),
      document([action({ sequence: 1 }), action({ sequence: 0 })]),
      document([action(), action({ sequence: 1 })]),
      { ...document(), project: 'another-project' },
      { ...document(), route: '/unknown' },
    ]) {
      const result = compileObservation({ document: doc, topology: graph });
      assert.ok(result.unresolved.length > 0);
      assert.throws(() => emitSpec(result.candidate), /unresolved/i);
    }
  });

  it('accepts case-insensitive route match against topology routes', () => {
    const graph = topology();
    graph.routes['/help/Plan0'] = {
      path: '/help/Plan0',
      filePath: 'src/views/help/Plan0.vue',
      title: 'Plan0',
      semanticKeywords: [],
      dynamicParams: [],
      transitions: [],
      elements: [],
    };
    const doc = document([
      action({
        sequence: 0,
        beforeUrl: 'http://fixture.test/start',
        afterUrl: 'http://fixture.test/help/plan0',
      }),
    ]);
    const result = compileObservation({ document: doc, topology: graph });
    assert.deepEqual(result.unresolved, []);
    assert.equal(result.candidate.stages[0].invariants.routeGuard?.targetUrlPattern, '^/help/plan0$');
  });

  it('produces deterministic candidates without mutating its inputs', () => {
    const input = { document: document(), topology: topology() };
    const original = structuredClone(input);
    const first = compileObservation(input);
    assert.deepEqual(input, original);
    assert.deepEqual(compileObservation(input), first);
  });
});
