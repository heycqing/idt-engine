import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  executeMidsceneIntent,
  normalizeMidsceneAction,
  resolveMidscenePlaywrightRuntime,
  type MidsceneAgentFactory,
  type MidscenePage,
} from '../../../src/idt/adapters/midscene-playwright.js';

const page: MidscenePage = { url: () => 'http://fixture.test/start' };

describe('normalizeMidsceneAction', () => {
  it('maps supported callback names into IDT action names', () => {
    assert.equal(normalizeMidsceneAction('tap'), 'click');
    assert.equal(normalizeMidsceneAction('click'), 'click');
    assert.equal(normalizeMidsceneAction('input'), 'input');
    assert.equal(normalizeMidsceneAction('fill'), 'fill');
    assert.equal(normalizeMidsceneAction('select'), 'select');
    assert.equal(normalizeMidsceneAction('check'), 'check');
  });

  it('preserves unsupported action labels without claiming support', () => {
    assert.equal(normalizeMidsceneAction('scroll'), 'scroll');
    assert.equal(normalizeMidsceneAction('drag'), 'drag');
  });
});

describe('Midscene Playwright peer', () => {
  it('uses the same Playwright peer module as @midscene/web', () => {
    const localRequire = createRequire(import.meta.url);
    const expectedEntry = localRequire.resolve('playwright');
    const midsceneEntry = localRequire.resolve('@midscene/web/playwright');
    const midscenePeerEntry = createRequire(midsceneEntry).resolve('playwright');
    assert.equal(expectedEntry, midscenePeerEntry);
    assert.equal(resolveMidscenePlaywrightRuntime().chromium, localRequire('playwright').chromium);
  });
});

describe('executeMidsceneIntent', () => {
  it('forwards normalized before/after callbacks and destroys the agent', async () => {
    const events: Array<{ phase: string; action: string }> = [];
    let destroyed = false;
    const factory: MidsceneAgentFactory = (_page, options) => ({
      async aiAct(intent) {
        assert.equal(options.generateReport, false);
        assert.equal(intent, 'Open details');
        await options.beforeInvokeAction('tap', { privateText: 'must not leak' });
        await options.afterInvokeAction('tap', { privateText: 'must not leak' });
        return 'Midscene summary is not evidence';
      },
      async destroy() { destroyed = true; },
      get reportFile() { return 'local-report.html'; },
    });

    const result = await executeMidsceneIntent({
      page,
      intent: 'Open details',
      factory,
      onAction: (event) => { events.push(event); },
    });

    assert.deepEqual(events, [
      { phase: 'before', action: 'click' },
      { phase: 'after', action: 'click' },
    ]);
    assert.equal(destroyed, true);
    assert.equal(result.reportFile, 'local-report.html');
    assert.equal(result.summary, 'Midscene summary is not evidence');
    assert.doesNotMatch(JSON.stringify(events), /privateText|must not leak/);
  });

  it('destroys the agent after aiAct fails and rethrows the failure', async () => {
    let destroyed = false;
    const factory: MidsceneAgentFactory = () => ({
      async aiAct(): Promise<string | undefined> { throw new Error('model unavailable'); },
      async destroy() { destroyed = true; },
    });

    await assert.rejects(
      executeMidsceneIntent({ page, intent: 'Open details', factory, onAction: () => {} }),
      /model unavailable/,
    );
    assert.equal(destroyed, true);
  });

  it('reports agent initialization failure without running callbacks', async () => {
    let callbacks = 0;
    const factory: MidsceneAgentFactory = () => { throw new Error('agent init failed'); };

    await assert.rejects(
      executeMidsceneIntent({
        page, intent: 'Open details', factory,
        onAction: () => { callbacks += 1; },
      }),
      /agent init failed/,
    );
    assert.equal(callbacks, 0);
  });

  it('does not treat an undefined rejection as a successful execution', async () => {
    const factory: MidsceneAgentFactory = () => ({
      async aiAct(): Promise<string | undefined> { return Promise.reject(undefined); },
      async destroy() {},
    });

    let rejected = false;
    try {
      await executeMidsceneIntent({ page, intent: 'Open details', factory, onAction: () => {} });
    } catch (error) {
      rejected = true;
      assert.equal(error, undefined);
    }
    assert.equal(rejected, true);
  });

  it('preserves unsupported callback actions so IDT can block the candidate', async () => {
    const actions: string[] = [];
    const factory: MidsceneAgentFactory = (_page, options) => ({
      async aiAct(): Promise<string | undefined> {
        await options.beforeInvokeAction('scroll', {});
        return undefined;
      },
      async destroy() {},
    });

    await executeMidsceneIntent({
      page, intent: 'Scroll the page', factory,
      onAction: (event) => { actions.push(event.action); },
    });

    assert.deepEqual(actions, ['scroll']);
  });

  it('runs action authorization before forwarding an action callback', async () => {
    const order: string[] = [];
    const factory: MidsceneAgentFactory = (_page, options) => ({
      async aiAct(): Promise<string | undefined> {
        await options.beforeInvokeAction('tap', { label: 'submit order' });
        return undefined;
      },
      async destroy() {},
    });

    await assert.rejects(executeMidsceneIntent({
      page, intent: 'Open details', factory,
      authorizeAction: (_name, param) => {
        order.push(`authorize:${(param as { label: string }).label}`);
        throw new Error('unsafe action blocked');
      },
      onAction: () => { order.push('record'); },
    }), /unsafe action blocked/);
    assert.deepEqual(order, ['authorize:submit order']);
  });

  it('passes model configuration to the agent without mutating process environment', async () => {
    const existingFamily = process.env.MIDSCENE_MODEL_FAMILY;
    const modelConfig = {
      MIDSCENE_MODEL_BASE_URL: 'https://model.example/v1',
      MIDSCENE_MODEL_FAMILY: 'gpt-6',
    };
    let received: Record<string, string | number> | undefined;
    const factory: MidsceneAgentFactory = (_page, options) => {
      received = options.modelConfig;
      return { async aiAct() { return undefined; }, async destroy() {} };
    };

    await executeMidsceneIntent({
      page, intent: 'Open details', factory, modelConfig, onAction: () => {},
    });

    assert.deepEqual(received, modelConfig);
    assert.equal(process.env.MIDSCENE_MODEL_FAMILY, existingFamily);
  });

  it('scopes opted-in report output to the local observation run and restores environment', async () => {
    const previous = process.env.MIDSCENE_RUN_DIR;
    let observedRunDir: string | undefined;
    const factory: MidsceneAgentFactory = (_page, options) => {
      observedRunDir = process.env.MIDSCENE_RUN_DIR;
      assert.equal(options.generateReport, true);
      assert.equal(options.reportFileName, 'midscene-report.html');
      return { async aiAct() { return undefined; }, async destroy() {} };
    };

    await executeMidsceneIntent({
      page, intent: 'Open details', factory, onAction: () => {},
      generateReport: true,
      reportFileName: 'midscene-report.html',
      reportDirectory: '.idt/observations/run/midscene_run',
    });

    assert.equal(observedRunDir, '.idt/observations/run/midscene_run');
    assert.equal(process.env.MIDSCENE_RUN_DIR, previous);
  });

  it('times out and cleans up agent when execution exceeds timeoutMs', async () => {
    let destroyed = false;
    const factory: MidsceneAgentFactory = () => ({
      async aiAct() {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return 'too late';
      },
      async destroy() { destroyed = true; },
    });

    await assert.rejects(executeMidsceneIntent({
      page,
      intent: 'Slow operation',
      factory,
      timeoutMs: 20,
      onAction: () => {},
    }), /timed out after 20ms/);

    assert.equal(destroyed, true);
  });
});
