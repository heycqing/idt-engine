import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { StateTransitionIR } from '../../../src/idt/core/ir-schema.js';
import { replayUntil, type ReplayPage } from '../../../src/idt/core/replay.js';
import type { ObservedElement } from '../../../src/idt/core/dom-observe.js';

class MockReplayPage implements ReplayPage {
  calls: string[] = [];

  url(): string {
    return 'http://host/current';
  }

  async goto(url: string): Promise<void> {
    this.calls.push(`goto:${url}`);
  }

  async click(role: string, name: string, timeoutMs: number): Promise<void> {
    this.calls.push(`click:${role}:${name}:${timeoutMs}`);
  }

  async fill(role: string, name: string, value: string, timeoutMs: number): Promise<void> {
    this.calls.push(`fill:${role}:${name}:${value}:${timeoutMs}`);
  }

  async check(role: string, name: string, timeoutMs: number): Promise<void> {
    this.calls.push(`check:${role}:${name}:${timeoutMs}`);
  }

  async selectOption(role: string, name: string, value: string, timeoutMs: number): Promise<void> {
    this.calls.push(`selectOption:${role}:${name}:${value}:${timeoutMs}`);
  }

  async waitForURL(pattern: string, timeoutMs: number): Promise<void> {
    this.calls.push(`waitForURL:${pattern}:${timeoutMs}`);
  }

  async waitForVisible(role: string, name: string, timeoutMs: number): Promise<void> {
    this.calls.push(`waitForVisible:${role}:${name}:${timeoutMs}`);
  }

  async ariaSnapshot(): Promise<string> {
    this.calls.push('ariaSnapshot');
    return '- button "确认去结账订单"';
  }

  async observe(): Promise<ObservedElement[]> {
    this.calls.push('observe');
    return [];
  }

  async installHitProbe(): Promise<void> {
    this.calls.push('installHitProbe');
  }

  async readHit(): Promise<string | null> {
    this.calls.push('readHit');
    return null;
  }
}

describe('replay', () => {
  it('Requirement 1: stops before failed CLICK in stage 0 (preceded by FILL and CHECK), no click and no waitForURL', async () => {
    const ir: StateTransitionIR = {
      flowId: 'flow_1122334455',
      intent: 'login and submit',
      oracle: 'regression-lock',
      description: 'login flow',
      initialRoute: '/login',
      setup: { notes: [] },
      unresolved: [],
      stages: [
        {
          stageIndex: 0,
          stageName: 'login stage',
          routePattern: '/login',
          actions: [
            {
              actionType: 'FILL',
              targetRole: 'textbox',
              targetName: 'username',
              inputValue: 'alice',
              timeoutMs: 3000,
              triggersRequest: false,
            },
            {
              actionType: 'CHECK',
              targetRole: 'checkbox',
              targetName: 'agree',
              timeoutMs: 3000,
              triggersRequest: false,
            },
            {
              actionType: 'CLICK',
              targetRole: 'button',
              targetName: 'submit',
              timeoutMs: 4000,
              triggersRequest: true,
            },
          ],
          invariants: {
            network: [],
          },
        },
      ],
    };

    const mockPage = new MockReplayPage();
    const snapshot = await replayUntil(
      ir,
      { stageIndex: 0, actionIndex: 2 },
      mockPage,
    );

    assert.equal(snapshot, '- button "确认去结账订单"');
    assert.deepEqual(mockPage.calls, [
      'goto:/login',
      'fill:textbox:username:alice:3000',
      'check:checkbox:agree:3000',
      'ariaSnapshot',
    ]);
    assert.ok(!mockPage.calls.some((c) => c.startsWith('click:')));
    assert.ok(!mockPage.calls.some((c) => c.startsWith('waitForURL:')));
  });

  it('Requirement 2: failure is stage 1 first action; stage 0 CLICK and waitForURL run, stage 1 action does not run', async () => {
    const ir: StateTransitionIR = {
      flowId: 'flow_1122334455',
      intent: 'multi stage flow',
      oracle: 'regression-lock',
      description: 'multi stage flow',
      initialRoute: '/step1',
      setup: { notes: [] },
      unresolved: [],
      stages: [
        {
          stageIndex: 0,
          stageName: 'step 1',
          routePattern: '/step1',
          actions: [
            {
              actionType: 'CLICK',
              targetRole: 'button',
              targetName: 'next',
              timeoutMs: 3500,
              triggersRequest: false,
            },
          ],
          invariants: {
            network: [],
            routeGuard: {
              targetUrlPattern: '^/step2$',
            },
          },
        },
        {
          stageIndex: 1,
          stageName: 'step 2',
          routePattern: '/step2',
          actions: [
            {
              actionType: 'CLICK',
              targetRole: 'button',
              targetName: 'finish',
              timeoutMs: 4000,
              triggersRequest: false,
            },
          ],
          invariants: {
            network: [],
          },
        },
      ],
    };

    const mockPage = new MockReplayPage();
    const snapshot = await replayUntil(
      ir,
      { stageIndex: 1, actionIndex: 0 },
      mockPage,
    );

    assert.equal(snapshot, '- button "确认去结账订单"');
    assert.deepEqual(mockPage.calls, [
      'goto:/step1',
      'click:button:next:3500',
      'waitForURL:^/step2$:3500',
      'ariaSnapshot',
    ]);
    assert.ok(!mockPage.calls.includes('click:button:finish:4000'));
  });

  it('uses the text locator path for completed routeGuard ready assertions during routeGuard replay', async () => {
    const ir: StateTransitionIR = {
      flowId: 'flow_1122334455', intent: 'multi stage route guards',
      oracle: 'regression-lock', description: 'multi stage route guards',
      initialRoute: '/step1', setup: { notes: [] }, unresolved: [],
      stages: [
        {
          stageIndex: 0, stageName: 'step 1', routePattern: '/step1', actions: [],
          invariants: {
            network: [],
            routeGuard: {
              targetUrlPattern: '^/step2$', readyRole: 'text', readyName: '第二步',
            },
          },
        },
        {
          stageIndex: 1, stageName: 'step 2', routePattern: '/step2', actions: [],
          invariants: {
            network: [],
            routeGuard: {
              targetUrlPattern: '^/done$', readyRole: 'heading', readyName: '完成',
            },
          },
        },
      ],
    };

    const mockPage = new MockReplayPage();
    await replayUntil(
      ir,
      { stageIndex: 1, actionIndex: 0, kind: 'routeGuard' },
      mockPage,
    );

    assert.deepEqual(mockPage.calls, [
      'goto:/step1',
      'waitForURL:^/step2$:5000',
      'waitForVisible:text:第二步:5000',
      'waitForURL:^/done$:5000',
      'ariaSnapshot',
    ]);
  });
});
