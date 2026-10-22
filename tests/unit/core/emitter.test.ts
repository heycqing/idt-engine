import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { emitSpec, emitIrFile } from '../../../src/idt/core/emitter.js';
import type { StateTransitionIR } from '../../../src/idt/core/ir-schema.js';

function createTempDir(prefix = 'idt-emit-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

describe('emitter test suite', () => {
  const projectRoot = process.cwd();
  const fixturesDir = path.resolve(projectRoot, 'tests/unit/core/fixtures');

  // Requirement 1: emitSpec on flow_aabbccddee.ir.json matches golden byte-for-byte
  it('Requirement 1: emitSpec on flow_aabbccddee.ir.json matches flow_aabbccddee.spec.ts byte-for-byte', () => {
    const irPath = path.join(fixturesDir, 'flow_aabbccddee.ir.json');
    const specPath = path.join(fixturesDir, 'flow_aabbccddee.spec.ts');
    const irContent = fs.readFileSync(irPath, 'utf8');
    const goldenSpec = fs.readFileSync(specPath, 'utf8');

    // Golden file itself has no \r
    assert.strictEqual(goldenSpec.includes('\r'), false, 'golden spec must not contain \\r');

    const result = emitSpec(JSON.parse(irContent));
    assert.strictEqual(result, goldenSpec, 'result must match golden spec exactly');
    assert.ok(result.includes('.fill('), 'must contain .fill(');
    assert.ok(result.includes('.check('), 'must contain .check(');
    assert.ok(result.includes('.click('), 'must contain .click(');
  });

  // Requirement 2: emitSpec on flow_1122334455.ir.json matches flow_1122334455.spec.ts byte-for-byte
  it('Requirement 2: emitSpec on flow_1122334455.ir.json matches flow_1122334455.spec.ts byte-for-byte', () => {
    const irPath = path.join(fixturesDir, 'flow_1122334455.ir.json');
    const specPath = path.join(fixturesDir, 'flow_1122334455.spec.ts');
    const irContent = fs.readFileSync(irPath, 'utf8');
    const goldenSpec = fs.readFileSync(specPath, 'utf8');

    assert.strictEqual(goldenSpec.includes('\r'), false, 'golden spec must not contain \\r');

    const result = emitSpec(JSON.parse(irContent));
    assert.strictEqual(result, goldenSpec, 'result must match golden spec exactly');
    assert.ok(result.includes('.selectOption('), 'must contain .selectOption(');
  });

  // Requirement 3: waitForResponse predicate has no status; flow_aabbccddee has expect status 200; forbidden words absent
  it('Requirement 3: waitForResponse predicate contains no status, contains status expect, no forbidden tokens', () => {
    const ir1 = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'flow_1122334455.ir.json'), 'utf8'));
    const ir2 = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'flow_aabbccddee.ir.json'), 'utf8'));
    const res1 = emitSpec(ir1);
    const res2 = emitSpec(ir2);

    for (const res of [res1, res2]) {
      const regex = /page\.waitForResponse\(\(res\)\s*=>[\s\S]*?\),/g;
      const matches = res.match(regex);
      assert.ok(matches && matches.length > 0, 'must have waitForResponse blocks');
      for (const block of matches) {
        assert.strictEqual(block.includes('status'), false, 'waitForResponse filter predicate must not contain status');
      }

      // Check forbidden tokens
      assert.strictEqual(res.includes('networkidle'), false);
      assert.strictEqual(res.includes('toHaveScreenshot'), false);
      assert.strictEqual(res.includes('waitForTimeout'), false);
      assert.strictEqual(res.includes('waitForLoadState'), false);
      assert.strictEqual(res.includes('localhost'), false);
      assert.strictEqual(res.includes('domcontentloaded'), false);
      assert.strictEqual(res.includes('fullPage'), false);
      assert.strictEqual(res.includes('enableVisualSnapshot'), false);
    }

    assert.ok(
      res2.includes('expect(response0.status()).toBe(200)'),
      'flow_aabbccddee must contain expect(response0.status()).toBe(200)'
    );
  });

  // Requirement 4: Calling emitSpec twice on same object produces identical result and no \r
  it('Requirement 4: calling emitSpec twice on the same object produces identical result without \\r', () => {
    const ir = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'flow_aabbccddee.ir.json'), 'utf8'));
    const out1 = emitSpec(ir);
    const out2 = emitSpec(ir);
    assert.strictEqual(out1, out2);
    assert.strictEqual(out1.includes('\r'), false);
  });

  // Requirement 5: Handwritten IR with multiple stages and responseTypes
  it('Requirement 5: multi-stage network contracts with responseType json and none', () => {
    const ir: StateTransitionIR = {
      flowId: 'flow_5555555555',
      intent: '多接口测试',
      oracle: 'regression-lock',
      description: '多接口测试描述',
      initialRoute: '/step1',
      setup: { notes: [] },
      unresolved: [],
      stages: [
        {
          stageIndex: 0,
          stageName: '第一步',
          routePattern: '/step1',
          actions: [
            {
              actionType: 'CLICK',
              targetRole: 'button',
              targetName: '提交',
              timeoutMs: 5000,
              triggersRequest: true,
            },
          ],
          invariants: {
            network: [
              {
                method: 'POST',
                urlPattern: '/api/first',
                expectedStatus: 200,
                responseType: 'json',
                assertResponseFields: {
                  code: 0,
                },
              },
              {
                method: 'DELETE',
                urlPattern: '/api/cleanup',
                expectedStatus: 204,
                responseType: 'none',
              },
            ],
          },
        },
        {
          stageIndex: 1,
          stageName: '第二步',
          routePattern: '/step2',
          actions: [
            {
              actionType: 'CLICK',
              targetRole: 'button',
              targetName: '下一步',
              timeoutMs: 5000,
              triggersRequest: true,
            },
          ],
          invariants: {
            network: [
              {
                method: 'GET',
                urlPattern: '/api/second',
                expectedStatus: 200,
                responseType: 'json',
              },
            ],
          },
        },
      ],
    };

    const out = emitSpec(ir);
    assert.ok(out.includes('response0'), 'must contain response0');
    assert.ok(out.includes('response1'), 'must contain response1');
    assert.ok(out.includes('response2'), 'must contain response2');
    assert.ok(out.includes('body0'), 'must contain body0');
    assert.ok(out.includes('body2'), 'must contain body2');
    assert.strictEqual(out.includes('body1'), false, 'must not contain body1');
    assert.strictEqual(out.includes('response1.json'), false, 'must not contain response1.json');
  });

  // Requirement 6: Handwritten IR where neither action has triggersRequest; first FILL is before Promise.all, CLICK in Promise.all without await
  it('Requirement 6: actions without triggersRequest -> last action is trigger, prior actions before Promise.all', () => {
    const ir: any = {
      flowId: 'flow_6666666666',
      intent: '默认触发动作',
      oracle: 'prose-case',
      description: '默认触发动作测试',
      initialRoute: '/form',
      setup: { notes: [] },
      unresolved: [],
      stages: [
        {
          stageIndex: 0,
          stageName: '填写表单',
          routePattern: '/form',
          actions: [
            {
              actionType: 'FILL',
              targetRole: 'textbox',
              targetName: '用户名',
              inputValue: 'alice',
            },
            {
              actionType: 'CLICK',
              targetRole: 'button',
              targetName: '确认',
            },
          ],
          invariants: {
            network: [
              {
                method: 'POST',
                urlPattern: '/api/submit',
              },
            ],
          },
        },
      ],
    };

    const out = emitSpec(ir);
    const promiseAllIndex = out.indexOf('Promise.all');
    assert.ok(promiseAllIndex > -1, 'must have Promise.all');

    const fillIndex = out.indexOf('fill("alice"');
    assert.ok(fillIndex > -1 && fillIndex < promiseAllIndex, 'FILL must appear before Promise.all');

    const clickIndex = out.indexOf('.click(');
    assert.ok(clickIndex > promiseAllIndex, 'CLICK must appear after Promise.all');

    // Check that the CLICK line does not start with await
    const lines = out.split('\n');
    const clickLine = lines.find((l) => l.includes('.click('));
    assert.ok(clickLine, 'must have click line');
    assert.strictEqual(clickLine.trim().startsWith('await'), false, 'click line in Promise.all must not start with await');
  });

  // Requirement 7: Action order CLICK (triggersRequest: true), FILL (false), CHECK (true)
  it('Requirement 7: last action with triggersRequest: true is trigger, others emitted before Promise.all with await', () => {
    const ir: any = {
      flowId: 'flow_7777777777',
      intent: '多动作触发',
      oracle: 'regression-lock',
      description: '多动作触发测试',
      initialRoute: '/settings',
      setup: { notes: [] },
      unresolved: [],
      stages: [
        {
          stageIndex: 0,
          stageName: '设置步骤',
          routePattern: '/settings',
          actions: [
            {
              actionType: 'CLICK',
              targetRole: 'button',
              targetName: '展开',
              triggersRequest: true,
            },
            {
              actionType: 'FILL',
              targetRole: 'textbox',
              targetName: '配置名',
              inputValue: 'conf1',
              triggersRequest: false,
            },
            {
              actionType: 'CHECK',
              targetRole: 'checkbox',
              targetName: '启用',
              triggersRequest: true,
            },
          ],
          invariants: {
            network: [
              {
                method: 'POST',
                urlPattern: '/api/save',
              },
            ],
          },
        },
      ],
    };

    const out = emitSpec(ir);
    const promiseAllIndex = out.indexOf('Promise.all');
    assert.ok(promiseAllIndex > -1);

    const clickIndex = out.indexOf('.click(');
    const fillIndex = out.indexOf('.fill(');
    const checkIndex = out.indexOf('.check(');

    assert.ok(clickIndex < promiseAllIndex, 'CLICK must appear before Promise.all');
    assert.ok(fillIndex < promiseAllIndex, 'FILL must appear before Promise.all');
    assert.ok(checkIndex > promiseAllIndex, 'CHECK must appear inside Promise.all');

    const lines = out.split('\n');
    const clickLine = lines.find((l) => l.includes('.click('));
    const fillLine = lines.find((l) => l.includes('.fill('));
    const checkLine = lines.find((l) => l.includes('.check('));

    assert.ok(clickLine?.trim().startsWith('await'), 'CLICK before Promise.all must start with await');
    assert.ok(fillLine?.trim().startsWith('await'), 'FILL before Promise.all must start with await');
    assert.strictEqual(checkLine?.trim().startsWith('await'), false, 'CHECK in Promise.all must not start with await');
  });

  // Requirement 8: Omitted timeoutMs and triggersRequest defaults to 5000 timeout
  it('Requirement 8: omitted timeoutMs defaults to 5000 in generated output', () => {
    const ir: any = {
      flowId: 'flow_8888888888',
      intent: '默认超时测试',
      oracle: 'prose-case',
      description: '默认超时',
      initialRoute: '/home',
      setup: { notes: [] },
      unresolved: [],
      stages: [
        {
          stageIndex: 0,
          stageName: '首页',
          routePattern: '/home',
          actions: [
            {
              actionType: 'CLICK',
              targetRole: 'button',
              targetName: '刷新',
            },
          ],
          invariants: {
            network: [
              {
                method: 'GET',
                urlPattern: '/api/refresh',
              },
            ],
          },
        },
      ],
    };

    const out = emitSpec(ir);
    assert.ok(out.includes('{ timeout: 5000 }'), 'must contain default timeout 5000');
  });

  // Requirement 9: targetName with quotes "他说\"好\"" escaped properly
  it('Requirement 9: targetName with quotes is properly escaped with JSON.stringify', () => {
    const ir: any = {
      flowId: 'flow_9999999999',
      intent: '引号测试',
      oracle: 'prose-case',
      description: '引号转义测试',
      initialRoute: '/chat',
      setup: { notes: [] },
      unresolved: [],
      stages: [
        {
          stageIndex: 0,
          stageName: '聊天',
          routePattern: '/chat',
          actions: [
            {
              actionType: 'CLICK',
              targetRole: 'button',
              targetName: '他说"好"',
            },
          ],
          invariants: {
            routeGuard: {
              targetUrlPattern: '/chat/done$',
            },
          },
        },
      ],
    };

    const out = emitSpec(ir);
    assert.ok(out.includes('他说\\"好\\"'), 'output must contain 他说\\"好\\"');
  });

  // Requirement 10: storageStatePath with backslashes converted to forward slashes; omitted storageStatePath produces no test.use
  it('Requirement 10: storageStatePath with backslashes converted to forward slashes and no test.use when omitted', () => {
    const irWithStorage: any = {
      flowId: 'flow_1010101010',
      intent: '存储状态测试',
      oracle: 'prose-case',
      description: '存储状态路径测试',
      initialRoute: '/page',
      setup: {
        storageStatePath: 'tests\\e2e\\states\\a.json',
        notes: [],
      },
      unresolved: [],
      stages: [
        {
          stageIndex: 0,
          stageName: '步骤',
          routePattern: '/page',
          actions: [
            {
              actionType: 'CLICK',
              targetRole: 'button',
              targetName: '确认',
            },
          ],
          invariants: {
            routeGuard: {
              targetUrlPattern: '/page/next$',
            },
          },
        },
      ],
    };

    const outWith = emitSpec(irWithStorage);
    assert.ok(
      outWith.includes('test.use({ storageState: "tests/e2e/states/a.json" });'),
      'must format storageStatePath with forward slashes'
    );
    assert.strictEqual(outWith.includes('\\\\'), false, 'must not contain backslashes');

    const irWithout = {
      ...irWithStorage,
      flowId: 'flow_2020202020',
      setup: { notes: [] },
    };
    const outWithout = emitSpec(irWithout);
    assert.strictEqual(outWithout.includes('test.use'), false, 'must not contain test.use when storageStatePath is omitted');
  });

  // Requirement 11: CLICK with empty network and no routeGuard throws exitCode 2
  it('Requirement 11: CLICK with empty network and no routeGuard throws exitCode === 2', () => {
    const ir: any = {
      flowId: 'flow_1111111111',
      intent: '无后置断言',
      oracle: 'prose-case',
      description: '非法阶段测试',
      initialRoute: '/cart',
      setup: { notes: [] },
      unresolved: [],
      stages: [
        {
          stageIndex: 0,
          stageName: '购物车',
          routePattern: '/cart',
          actions: [
            {
              actionType: 'CLICK',
              targetRole: 'button',
              targetName: '无断言点击',
            },
          ],
          invariants: {
            network: [],
          },
        },
      ],
    };

    assert.throws(
      () => emitSpec(ir),
      (err: any) => {
        assert.strictEqual(err.exitCode, 2);
        return true;
      }
    );
  });

  // Requirement 12: emitIrFile in temp directory writes spec.ts matching emitSpec; second call overwrites with same content
  it('Requirement 12: emitIrFile writes matching spec.ts in temp dir, overwriting on repeat', () => {
    const tmp = createTempDir('idt-emit-r12-');
    try {
      const flowId = 'flow_1212121212';
      const irContent = {
        flowId,
        intent: '测试意图',
        oracle: 'prose-case',
        description: '临时目录测试',
        initialRoute: '/home',
        setup: { notes: [] },
        unresolved: [],
        stages: [
          {
            stageIndex: 0,
            stageName: '首页',
            routePattern: '/home',
            actions: [
              {
                actionType: 'CLICK',
                targetRole: 'button',
                targetName: '进入',
                timeoutMs: 5000,
                triggersRequest: true,
              },
            ],
            invariants: {
              routeGuard: {
                targetUrlPattern: '/home/next$',
              },
            },
          },
        ],
      };

      const irPath = path.join(tmp, `${flowId}.ir.json`);
      fs.writeFileSync(irPath, JSON.stringify(irContent, null, 2), 'utf8');

      const expectedSource = emitSpec(irContent);

      const res1 = emitIrFile(tmp, irPath);
      assert.strictEqual(res1.specPath, path.join(tmp, `${flowId}.spec.ts`));
      assert.strictEqual(res1.source, expectedSource);
      assert.strictEqual(fs.readFileSync(res1.specPath, 'utf8'), expectedSource);

      // Repeat call overwrites cleanly
      const res2 = emitIrFile(tmp, irPath);
      assert.strictEqual(res2.source, expectedSource);
      assert.strictEqual(fs.readFileSync(res2.specPath, 'utf8'), expectedSource);
    } finally {
      removeTempDir(tmp);
    }
  });

  // Requirement 13: Invalid IR with existing OLD spec throws exitCode 2, spec remains OLD, no new spec created
  it('Requirement 13: CLICK without network or routeGuard throws exitCode 2, old spec remains unchanged', () => {
    const tmp = createTempDir('idt-emit-r13-');
    try {
      const flowId = 'flow_1313131313';
      const irContent = {
        flowId,
        intent: '非法意图',
        oracle: 'prose-case',
        description: '非法IR测试',
        initialRoute: '/cart',
        setup: { notes: [] },
        unresolved: [],
        stages: [
          {
            stageIndex: 0,
            stageName: '购物车',
            routePattern: '/cart',
            actions: [
              {
                actionType: 'CLICK',
                targetRole: 'button',
                targetName: '去结算',
              },
            ],
            invariants: {
              network: [],
            },
          },
        ],
      };

      const irPath = path.join(tmp, `${flowId}.ir.json`);
      const specPath = path.join(tmp, `${flowId}.spec.ts`);
      fs.writeFileSync(irPath, JSON.stringify(irContent, null, 2), 'utf8');
      fs.writeFileSync(specPath, 'OLD', 'utf8');

      assert.throws(
        () => emitIrFile(tmp, irPath),
        (err: any) => {
          assert.strictEqual(err.exitCode, 2);
          return true;
        }
      );

      assert.strictEqual(fs.readFileSync(specPath, 'utf8'), 'OLD');
      const files = fs.readdirSync(tmp);
      assert.deepStrictEqual(files.sort(), [`${flowId}.ir.json`, `${flowId}.spec.ts`].sort());
    } finally {
      removeTempDir(tmp);
    }
  });

  // Requirement 14: flowId mismatch with fileStem throws exitCode 2 and does not create spec
  it('Requirement 14: flowId mismatch with fileStem throws exitCode 2 without creating spec', () => {
    const tmp = createTempDir('idt-emit-r14-');
    try {
      const fileStem = 'flow_1414141414';
      const insideFlowId = 'flow_2424242424';
      const irContent = {
        flowId: insideFlowId,
        intent: '主干不一致',
        oracle: 'prose-case',
        description: '主干不一致测试',
        initialRoute: '/start',
        setup: { notes: [] },
        unresolved: [],
        stages: [
          {
            stageIndex: 0,
            stageName: '开始',
            routePattern: '/start',
            actions: [
              {
                actionType: 'CLICK',
                targetRole: 'button',
                targetName: '进入',
              },
            ],
            invariants: {
              routeGuard: {
                targetUrlPattern: '/start/done$',
              },
            },
          },
        ],
      };

      const irPath = path.join(tmp, `${fileStem}.ir.json`);
      fs.writeFileSync(irPath, JSON.stringify(irContent, null, 2), 'utf8');

      assert.throws(
        () => emitIrFile(tmp, irPath),
        (err: any) => {
          assert.strictEqual(err.exitCode, 2);
          return true;
        }
      );

      const files = fs.readdirSync(tmp);
      assert.strictEqual(files.some((f) => f.endsWith('.spec.ts')), false);
    } finally {
      removeTempDir(tmp);
    }
  });

  // Requirement 15: spawnSync runs cli.ts emit with OPENAI_API_KEY="" -> 0 for valid, 2 for invalid, preserves OLD spec
  it('Requirement 15: cli.ts emit works without OPENAI_API_KEY, returns 0 for valid IR, 2 for invalid IR preserving OLD', () => {
    const tmp = createTempDir('idt-emit-r15-');
    try {
      const cliPath = path.resolve(projectRoot, 'scripts/idt/cli.ts');

      // 1. Valid IR
      const validFlowId = 'flow_1515151515';
      const validIr = {
        flowId: validFlowId,
        intent: 'CLI有效测试',
        oracle: 'prose-case',
        description: 'CLI有效测试',
        initialRoute: '/home',
        setup: { notes: [] },
        unresolved: [],
        stages: [
          {
            stageIndex: 0,
            stageName: '首页',
            routePattern: '/home',
            actions: [
              {
                actionType: 'CLICK',
                targetRole: 'button',
                targetName: '进入',
                timeoutMs: 5000,
                triggersRequest: true,
              },
            ],
            invariants: {
              routeGuard: {
                targetUrlPattern: '/home/next$',
              },
            },
          },
        ],
      };

      const validIrPath = path.join(tmp, `${validFlowId}.ir.json`);
      fs.writeFileSync(validIrPath, JSON.stringify(validIr, null, 2), 'utf8');

      const resValid = spawnSync(
        process.execPath,
        ['--import', 'tsx', cliPath, 'emit', validIrPath],
        {
          cwd: projectRoot,
          env: {
            ...process.env,
            OPENAI_API_KEY: '',
          },
          encoding: 'utf8',
        }
      );

      assert.strictEqual(resValid.status, 0, `Expected 0, stderr: ${resValid.stderr}`);
      assert.ok(
        (resValid.stdout || '').includes('.spec.ts'),
        `stdout should contain .spec.ts, got: ${resValid.stdout}`
      );

      // 2. Invalid IR (Requirement 13 style)
      const invalidFlowId = 'flow_9595959595';
      const invalidIr = {
        flowId: invalidFlowId,
        intent: 'CLI非法测试',
        oracle: 'prose-case',
        description: 'CLI非法测试',
        initialRoute: '/cart',
        setup: { notes: [] },
        unresolved: [],
        stages: [
          {
            stageIndex: 0,
            stageName: '购物车',
            routePattern: '/cart',
            actions: [
              {
                actionType: 'CLICK',
                targetRole: 'button',
                targetName: '去结算',
              },
            ],
            invariants: {
              network: [],
            },
          },
        ],
      };

      const invalidIrPath = path.join(tmp, `${invalidFlowId}.ir.json`);
      const invalidSpecPath = path.join(tmp, `${invalidFlowId}.spec.ts`);
      fs.writeFileSync(invalidIrPath, JSON.stringify(invalidIr, null, 2), 'utf8');
      fs.writeFileSync(invalidSpecPath, 'OLD', 'utf8');

      const resInvalid = spawnSync(
        process.execPath,
        ['--import', 'tsx', cliPath, 'emit', invalidIrPath],
        {
          cwd: projectRoot,
          env: {
            ...process.env,
            OPENAI_API_KEY: '',
          },
          encoding: 'utf8',
        }
      );

      assert.strictEqual(resInvalid.status, 2, `Expected 2, got: ${resInvalid.status}`);
      assert.strictEqual(fs.readFileSync(invalidSpecPath, 'utf8'), 'OLD');
    } finally {
      removeTempDir(tmp);
    }
  });

  // Additional validation checks
  it('Validation: dynamic parameter ":" in route throws exitCode 2 with "具体参数"', () => {
    const ir: any = {
      flowId: 'flow_1616161616',
      intent: '动态参数测试',
      oracle: 'prose-case',
      description: '动态参数',
      initialRoute: '/items/:id',
      setup: { notes: [] },
      unresolved: [],
      stages: [
        {
          stageIndex: 0,
          stageName: '详情',
          routePattern: '/items/:id',
          actions: [],
          invariants: {},
        },
      ],
    };

    assert.throws(
      () => emitSpec(ir),
      (err: any) => {
        assert.strictEqual(err.exitCode, 2);
        assert.ok(err.message.includes('具体参数'));
        return true;
      }
    );
  });

  it('Validation: unresolved non-empty throws exitCode 2', () => {
    const ir: any = {
      flowId: 'flow_1717171717',
      intent: '未解决项测试',
      oracle: 'prose-case',
      description: '未解决项',
      initialRoute: '/home',
      setup: { notes: [] },
      unresolved: ['未明确支付方式'],
      stages: [
        {
          stageIndex: 0,
          stageName: '首页',
          routePattern: '/home',
          actions: [],
          invariants: {},
        },
      ],
    };

    assert.throws(
      () => emitSpec(ir),
      (err: any) => {
        assert.strictEqual(err.exitCode, 2);
        return true;
      }
    );
  });

  it('Validation: FILL without inputValue throws exitCode 2; with "" passes', () => {
    const irBad: any = {
      flowId: 'flow_1818181818',
      intent: '输入值缺失',
      oracle: 'prose-case',
      description: '输入值测试',
      initialRoute: '/form',
      setup: { notes: [] },
      unresolved: [],
      stages: [
        {
          stageIndex: 0,
          stageName: '表单',
          routePattern: '/form',
          actions: [
            {
              actionType: 'FILL',
              targetRole: 'textbox',
              targetName: '输入框',
              // inputValue missing
            },
          ],
          invariants: {
            routeGuard: { targetUrlPattern: '/done$' },
          },
        },
      ],
    };

    assert.throws(
      () => emitSpec(irBad),
      (err: any) => {
        assert.strictEqual(err.exitCode, 2);
        return true;
      }
    );

    const irGood = {
      ...irBad,
      stages: [
        {
          ...irBad.stages[0],
          actions: [
            {
              actionType: 'FILL',
              targetRole: 'textbox',
              targetName: '输入框',
              inputValue: '',
            },
          ],
        },
      ],
    };

    const out = emitSpec(irGood);
    assert.ok(out.includes('.fill("", { timeout: 5000 })'));
  });

  it('Validation: readyRole and readyName must be both present or both absent', () => {
    const ir: any = {
      flowId: 'flow_1919191919',
      intent: '守卫部分属性',
      oracle: 'prose-case',
      description: '守卫测试',
      initialRoute: '/home',
      setup: { notes: [] },
      unresolved: [],
      stages: [
        {
          stageIndex: 0,
          stageName: '首页',
          routePattern: '/home',
          actions: [],
          invariants: {
            routeGuard: {
              targetUrlPattern: '/home$',
              readyRole: 'heading',
              // readyName missing
            },
          },
        },
      ],
    };

    assert.throws(
      () => emitSpec(ir),
      (err: any) => {
        assert.strictEqual(err.exitCode, 2);
        return true;
      }
    );
  });

  it('Validation: assertResponseFields segment invalid throws exitCode 2', () => {
    const ir: any = {
      flowId: 'flow_2121212121',
      intent: '字段非法',
      oracle: 'prose-case',
      description: '字段非法测试',
      initialRoute: '/home',
      setup: { notes: [] },
      unresolved: [],
      stages: [
        {
          stageIndex: 0,
          stageName: '首页',
          routePattern: '/home',
          actions: [],
          invariants: {
            network: [
              {
                method: 'GET',
                urlPattern: '/api/data',
                assertResponseFields: {
                  'invalid-key': 123,
                },
              },
            ],
          },
        },
      ],
    };

    assert.throws(
      () => emitSpec(ir),
      (err: any) => {
        assert.strictEqual(err.exitCode, 2);
        return true;
      }
    );
  });

  it('Validation: emitIrFile without .ir.json extension throws exitCode 2', () => {
    assert.throws(
      () => emitIrFile(process.cwd(), 'tests/e2e/foo.txt'),
      (err: any) => {
        assert.strictEqual(err.exitCode, 2);
        return true;
      }
    );
  });
  it('emits hash urls when the router is in hash mode', () => {
    const ir = JSON.parse(
      fs.readFileSync(path.join(fixturesDir, 'flow_aabbccddee.ir.json'), 'utf8'),
    );
    const source = emitSpec(ir, { mode: 'hash' });

    assert.match(source, /page\.goto\("\/#\/cart"\)/);
    assert.match(source, /waitForURL\(new RegExp\("#\/checkout\$"\)/);
    assert.match(source, /toHaveURL\(new RegExp\("#\/checkout\/success\$"\)\)/);
    assert.equal(source.includes('new RegExp("/checkout$")'), false);
  });

  it('puts the base before the hash in goto but not in the pattern', () => {
    const ir = JSON.parse(
      fs.readFileSync(path.join(fixturesDir, 'flow_aabbccddee.ir.json'), 'utf8'),
    );
    const source = emitSpec(ir, { mode: 'hash', base: '/trade/' });
    assert.match(source, /page\.goto\("\/trade\/#\/cart"\)/);
    assert.match(source, /new RegExp\("#\/checkout\$"\)/);
    assert.equal(source.includes('/trade/#/checkout'), false);
  });

  it('is byte-identical to the fixture when no router options are given', () => {
    const ir = JSON.parse(
      fs.readFileSync(path.join(fixturesDir, 'flow_aabbccddee.ir.json'), 'utf8'),
    );
    const expected = fs.readFileSync(
      path.join(fixturesDir, 'flow_aabbccddee.spec.ts'),
      'utf8',
    );
    assert.equal(emitSpec(ir), expected);
    assert.equal(emitSpec(ir, { mode: 'history' }), expected);
  });
  it('locates a text pseudo-role with getByText, exact and not first()', () => {
    const ir = JSON.parse(
      fs.readFileSync(path.join(fixturesDir, 'flow_aabbccddee.ir.json'), 'utf8'),
    );
    ir.stages[0].actions[0].targetRole = 'text';
    ir.stages[0].actions[0].targetName = '全部';

    const source = emitSpec(ir);
    assert.match(source, /getByText\("全部", \{ exact: true \}\)/);
    assert.equal(source.includes("getByRole(\"text\""), false);
    // 重复文本要让 strict mode 报错，不能靠 .first() 掩盖
    assert.equal(source.includes('.first()'), false);
  });
});
