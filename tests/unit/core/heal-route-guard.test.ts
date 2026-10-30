import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StateTransitionIR } from '../../../src/idt/core/ir-schema.js';
import { emitSpec } from '../../../src/idt/core/emitter.js';
import { heal, locateHealTarget } from '../../../src/idt/core/healer.js';
import { replayUntil, type ReplayPage } from '../../../src/idt/core/replay.js';

function guardIr(readyName = '智能交易登录'): StateTransitionIR {
  return {
    flowId: 'flow_aaaabbbbcc',
    intent: '打开首页',
    oracle: 'regression-lock',
    description: 'open home',
    initialRoute: '/',
    setup: { notes: [] },
    unresolved: [],
    stages: [
      {
        stageIndex: 0,
        stageName: 'home',
        routePattern: '/',
        actions: [],
        invariants: {
          network: [],
          routeGuard: {
            targetUrlPattern: '/',
            readyRole: 'heading',
            readyName,
          },
        },
      },
    ],
  };
}

function write(dir: string, ir: StateTransitionIR) {
  const irPath = path.join(dir, `${ir.flowId}.ir.json`);
  const specPath = path.join(dir, `${ir.flowId}.spec.ts`);
  const spec = emitSpec(ir);
  fs.writeFileSync(irPath, JSON.stringify(ir, null, 2) + '\n', 'utf8');
  fs.writeFileSync(specPath, spec, 'utf8');
  const line =
    spec.split(/\r?\n/).findIndex((l) => l.includes('toBeVisible()')) + 1;
  return { irPath, specPath, spec, line };
}

describe('heal route guard ready assertion', () => {
  it('locates a routeGuard ready assertion as a heal target', () => {
    const ir = guardIr();
    const spec = emitSpec(ir);
    const line = spec.split(/\r?\n/).findIndex((l) => l.includes('toBeVisible()')) + 1;

    const target = locateHealTarget(spec, ir, {
      line,
      message: 'TimeoutError: locator.click: Timeout 5000ms exceeded',
    });

    assert.equal(target.kind, 'routeGuard');
    assert.equal(target.stageIndex, 0);
    assert.equal(target.role, 'heading');
    assert.equal(target.name, '智能交易登录');
  });

  it('replays the whole stage and its url guard before snapshotting', async () => {
    const ir = guardIr();
    const calls: string[] = [];
    const page: ReplayPage = {
      url() {
        return 'http://host/current';
      },
      async goto(url) {
        calls.push(`goto ${url}`);
      },
      async click() {},
      async fill() {},
      async check() {},
      async selectOption() {},
      async waitForURL(pattern) {
        calls.push(`waitForURL ${pattern}`);
      },
      async waitForVisible() {},
      async ariaSnapshot() {
        calls.push('snapshot');
        return '- heading "真实标题"';
      },
      async observe() {
        return [];
      },
      async installHitProbe() {},
      async readHit() {
        return null;
      },
    };

    const snapshot = await replayUntil(
      ir,
      { stageIndex: 0, actionIndex: 0, kind: 'routeGuard' },
      page,
    );

    assert.equal(snapshot, '- heading "真实标题"');
    // history 模式下 toGuardPattern 原样返回 targetUrlPattern，不补 $
    assert.deepEqual(calls, ['goto /', 'waitForURL /', 'snapshot']);
  });

  it('locates and heals a text routeGuard ready assertion', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idt-heal-text-guard-'));
    try {
      const ir = guardIr('智能交易登陆');
      const guard = ir.stages[0].invariants.routeGuard!;
      guard.readyRole = 'text';
      const { irPath, specPath, spec, line } = write(dir, ir);

      assert.match(spec, /getByText\("智能交易登陆", \{ exact: true \}\)/);
      assert.equal(
        locateHealTarget(spec, ir, {
          line,
          message: 'TimeoutError: expect.toBeVisible Timeout',
        }).role,
        'text',
      );

      let run = 0;
      const result = await heal({
        projectRoot: dir,
        specPath,
        runSpec: async () => {
          run += 1;
          return run === 1
            ? {
                exitCode: 1,
                report: {
                  suites: [{ specs: [{ tests: [{ results: [{
                    status: 'failed',
                    errors: [{
                      message: 'TimeoutError: expect.toBeVisible Timeout',
                      location: { line },
                    }],
                  }] }] }] }],
                },
              }
            : { exitCode: 0, report: {} };
        },
        replay: async () => '- text: 智能交易登录',
      });

      assert.equal(result.exitCode, 0, result.reason);
      assert.equal(result.newTargetName, '智能交易登录');
      const healedIr = JSON.parse(fs.readFileSync(irPath, 'utf8'));
      assert.equal(healedIr.stages[0].invariants.routeGuard.readyName, '智能交易登录');
      assert.match(
        fs.readFileSync(specPath, 'utf8'),
        /getByText\("智能交易登录", \{ exact: true \}\)/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rewrites readyName in the IR and re-emits the spec', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idt-heal-guard-'));
    try {
      const ir = guardIr('智能交易登陆');
      const { irPath, specPath, line } = write(dir, ir);

      let run = 0;
      const result = await heal({
        projectRoot: dir,
        specPath,
        runSpec: async () => {
          run += 1;
          // 第一次失败在 ready 断言行，改名之后第二次通过
          if (run === 1) {
            return {
              exitCode: 1,
              report: {
                suites: [
                  {
                    specs: [
                      {
                        tests: [
                          {
                            results: [
                              {
                                status: 'failed',
                                errors: [
                                  {
                                    message: 'TimeoutError: expect.toBeVisible Timeout',
                                    location: { line },
                                  },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            };
          }
          return { exitCode: 0, report: {} };
        },
        replay: async () => '- heading "智能交易登录"',
      });

      assert.equal(result.exitCode, 0, result.reason);
      assert.equal(result.replaced, true);
      assert.equal(result.newTargetName, '智能交易登录');

      const healedIr = JSON.parse(fs.readFileSync(irPath, 'utf8'));
      assert.equal(healedIr.stages[0].invariants.routeGuard.readyName, '智能交易登录');
      assert.match(
        fs.readFileSync(specPath, 'utf8'),
        /getByRole\("heading", \{ name: "智能交易登录", exact: true \}\)/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
