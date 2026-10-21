import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { compileIntent, IR_SYSTEM_PROMPT, type ModelClient } from '../../../src/idt/core/ir-compiler.js';
import { flowIdFromIntent } from '../../../src/idt/core/intent.js';
import { OpenAiClient } from '../../../src/idt/core/openai-client.js';

function createTempDir(prefix = 'idt-comp-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

function writeFile(dir: string, relPath: string, content: string): void {
  const fullPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function setupCartFixture(dir: string, extraCartSlice = ''): void {
  writeFile(
    dir,
    'src/pages/cart/index.tsx',
    `
    import React from 'react';
    export default function Cart() {
      const handleCheckout = () => {
        ${extraCartSlice}
        navigate('/checkout');
      };
      return (
        <div>
          <button onClick={handleCheckout}>去结算</button>
        </div>
      );
    }
    `
  );

  writeFile(
    dir,
    'src/pages/checkout/index.tsx',
    `
    import React from 'react';
    export default function Checkout() {
      const handlePay = () => {
        fetch('/api/orders', { method: 'POST' });
        navigate('/checkout/success');
      };
      return (
        <div>
          <button onClick={handlePay}>立即支付</button>
        </div>
      );
    }
    `
  );

  writeFile(
    dir,
    'src/pages/checkout/success/index.tsx',
    `
    import React from 'react';
    export default function Success() {
      return <div>支付成功</div>;
    }
    `
  );
}

function createValidModelIr(forgedFlowId = 'flow_0123456789'): any {
  return {
    flowId: forgedFlowId,
    intent: '购物车去结算并支付成功',
    oracle: 'regression-lock',
    description: '购物车完整支付链路',
    initialRoute: '/cart',
    setup: {
      notes: [],
    },
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
            timeoutMs: 5000,
            triggersRequest: false,
          },
        ],
        invariants: {
          network: [],
          routeGuard: {
            targetUrlPattern: '/checkout',
          },
        },
      },
      {
        stageIndex: 1,
        stageName: '结算确认',
        routePattern: '/checkout',
        actions: [
          {
            actionType: 'CLICK',
            targetRole: 'button',
            targetName: '立即支付',
            timeoutMs: 5000,
            triggersRequest: true,
          },
        ],
        invariants: {
          network: [
            {
              method: 'POST',
              urlPattern: '/api/orders',
              expectedStatus: 200,
              responseType: 'json',
            },
          ],
          routeGuard: {
            targetUrlPattern: '/checkout/success',
          },
        },
      },
      {
        stageIndex: 2,
        stageName: '支付成功页',
        routePattern: '/checkout/success',
        actions: [
          {
            actionType: 'FILL',
            targetRole: 'textbox',
            targetName: '备注',
            inputValue: '完成',
          },
        ],
        invariants: {
          network: [],
        },
      },
    ],
  };
}

describe('ir-compiler', () => {
  it('Requirement 8: First model response invalid JSON, second valid IR -> complete called twice, flowId overridden, no spec.ts', async () => {
    const tmp = createTempDir();
    try {
      setupCartFixture(tmp);

      let callCount = 0;
      const model: ModelClient = {
        async complete() {
          callCount++;
          if (callCount === 1) {
            return 'Invalid JSON {{{';
          }
          return JSON.stringify(createValidModelIr('flow_0123456789'));
        },
      };

      const intent = '购物车去结算并支付成功';
      const expectedFlowId = flowIdFromIntent(intent);

      const ir = await compileIntent({
        projectRoot: tmp,
        intent,
        model,
      });

      assert.equal(callCount, 2);
      assert.equal(ir.flowId, expectedFlowId);
      assert.notEqual(ir.flowId, 'flow_0123456789');

      // Check file on disk
      const generatedDir = path.join(tmp, 'tests/e2e/generated');
      const irFile = path.join(generatedDir, `${expectedFlowId}.ir.json`);
      assert.ok(fs.existsSync(irFile), `IR file should exist at ${irFile}`);

      const savedIr = JSON.parse(fs.readFileSync(irFile, 'utf8'));
      assert.equal(savedIr.flowId, expectedFlowId);

      // Check no .spec.ts exists on disk
      const specFile = path.join(generatedDir, `${expectedFlowId}.spec.ts`);
      assert.ok(!fs.existsSync(specFile), `spec.ts must not exist on disk`);
    } finally {
      removeTempDir(tmp);
    }
  });

  it('Requirement 9: Model returns not-json twice -> exitCode 1, error saved in .idt/last-compile-error.json, no IR or spec written', async () => {
    const tmp = createTempDir();
    try {
      setupCartFixture(tmp);

      let callCount = 0;
      const model: ModelClient = {
        async complete() {
          callCount++;
          return 'not-json';
        },
      };

      const intent = '购物车去结算并支付成功';

      await assert.rejects(
        async () => {
          await compileIntent({
            projectRoot: tmp,
            intent,
            model,
          });
        },
        (err: any) => {
          assert.equal(err.exitCode, 1);
          return true;
        }
      );

      assert.equal(callCount, 2);

      // Check .idt/last-compile-error.json
      const errorFile = path.join(tmp, '.idt/last-compile-error.json');
      assert.ok(fs.existsSync(errorFile), 'last-compile-error.json must exist');
      const errorContent = fs.readFileSync(errorFile, 'utf8');
      assert.ok(
        errorContent.includes('not-json'),
        'last-compile-error.json must contain original raw response'
      );

      // Check no IR or spec generated
      const generatedDir = path.join(tmp, 'tests/e2e/generated');
      assert.ok(
        !fs.existsSync(generatedDir) ||
          fs.readdirSync(generatedDir).length === 0,
        'No .ir.json or .spec.ts should be generated'
      );
    } finally {
      removeTempDir(tmp);
    }
  });

  it('Requirement 14: Code slice contains sk-abcdefghijklmnopqrstuvwxyz -> redacted in model request', async () => {
    const tmp = createTempDir();
    try {
      setupCartFixture(
        tmp,
        'const secretKey = "sk-abcdefghijklmnopqrstuvwxyz";'
      );

      let capturedUserMessage = '';
      const model: ModelClient = {
        async complete(req) {
          capturedUserMessage = req.messages[0].content;
          return JSON.stringify(createValidModelIr());
        },
      };

      const intent = '购物车去结算并支付成功';
      await compileIntent({
        projectRoot: tmp,
        intent,
        model,
      });

      assert.ok(
        capturedUserMessage.includes('[REDACTED]'),
        'Message sent to model should contain [REDACTED]'
      );
      assert.ok(
        !capturedUserMessage.includes('sk-abcdefghijklmnopqrstuvwxyz'),
        'Message sent to model must not contain raw secret'
      );
    } finally {
      removeTempDir(tmp);
    }
  });

  it('Requirement 15: Target .ir.json already exists -> without force exitCode 2 and content unchanged', async () => {
    const tmp = createTempDir();
    try {
      setupCartFixture(tmp);

      const intent = '购物车去结算并支付成功';
      const flowId = flowIdFromIntent(intent);
      const generatedDir = path.join(tmp, 'tests/e2e/generated');
      fs.mkdirSync(generatedDir, { recursive: true });
      const targetIrFile = path.join(generatedDir, `${flowId}.ir.json`);
      const originalContent = JSON.stringify({ custom: 'original-data' });
      fs.writeFileSync(targetIrFile, originalContent, 'utf8');

      const model: ModelClient = {
        async complete() {
          return JSON.stringify(createValidModelIr());
        },
      };

      await assert.rejects(
        async () => {
          await compileIntent({
            projectRoot: tmp,
            intent,
            model,
            force: false,
          });
        },
        (err: any) => {
          assert.equal(err.exitCode, 2);
          return true;
        }
      );

      // Verify file content did not change
      const afterContent = fs.readFileSync(targetIrFile, 'utf8');
      assert.equal(afterContent, originalContent);
    } finally {
      removeTempDir(tmp);
    }
  });

  it('Requirement 17: Injected fetch receives temperature 0 and response_format json_object without network access', async () => {
    let capturedBody: any = null;
    let capturedUrl = '';

    const mockFetch = async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: '{"result": "mock"}',
              },
            },
          ],
        }),
      } as any;
    };

    const client = new OpenAiClient({
      apiKey: 'test-key-123',
      baseUrl: 'https://mock.api.example.com/v1',
      modelName: 'gpt-4o',
      fetchFn: mockFetch,
    });

    const result = await client.complete({
      system: 'Test system prompt',
      messages: [{ role: 'user', content: 'Test user message' }],
      temperature: 0,
      responseFormat: 'json_object',
    });

    assert.equal(result, '{"result": "mock"}');
    assert.equal(capturedUrl, 'https://mock.api.example.com/v1/chat/completions');
    assert.equal(capturedBody.temperature, 0);
    assert.deepEqual(capturedBody.response_format, { type: 'json_object' });
    assert.equal(capturedBody.model, 'gpt-4o');
  });

  it('Requirement 18: gen command without OPENAI_API_KEY exits with code 2 and stdout/stderr contains OPENAI_API_KEY', () => {
    const projectRoot = process.cwd();
    const cliPath = path.resolve(projectRoot, 'scripts/idt/cli.ts');

    const res = spawnSync(
      process.execPath,
      ['--import', 'tsx', cliPath, 'gen', '测试意图'],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          OPENAI_API_KEY: '',
        },
        encoding: 'utf8',
      }
    );

    assert.equal(res.status, 2);
    const combinedOutput = `${res.stdout || ''}\n${res.stderr || ''}`;
    assert.ok(
      combinedOutput.includes('OPENAI_API_KEY'),
      `Output should contain OPENAI_API_KEY, got: ${combinedOutput}`
    );
  });
  it('injects flowId, intent and oracle before schema validation', async () => {
    const tmp = createTempDir();
    try {
      setupCartFixture(tmp);

      // The model omits the three engine-authored fields entirely. flowId is a
      // hash of the intent, so no model can produce it; requiring it before the
      // overwrite made every response invalid.
      const modelIr: any = createValidModelIr();
      delete modelIr.flowId;
      delete modelIr.intent;
      delete modelIr.oracle;

      let callCount = 0;
      const model: ModelClient = {
        async complete() {
          callCount += 1;
          return JSON.stringify(modelIr);
        },
      };

      const intent = '购物车去结算并支付成功';
      const ir = await compileIntent({ projectRoot: tmp, intent, model });

      assert.equal(callCount, 1, 'must validate on the first response, not retry');
      assert.equal(ir.flowId, flowIdFromIntent(intent));
      assert.equal(ir.intent, intent);
      assert.equal(ir.oracle, 'regression-lock');
    } finally {
      removeTempDir(tmp);
    }
  });

  it('ignores the values the model supplies for the engine-authored fields', async () => {
    const tmp = createTempDir();
    try {
      setupCartFixture(tmp);

      const modelIr: any = createValidModelIr('flow_abcdef0123');
      modelIr.intent = '模型瞎写的意图';
      modelIr.oracle = 'prose-case';

      const model: ModelClient = {
        async complete() {
          return JSON.stringify(modelIr);
        },
      };

      const intent = '购物车去结算并支付成功';
      const ir = await compileIntent({ projectRoot: tmp, intent, model });

      assert.equal(ir.flowId, flowIdFromIntent(intent));
      assert.notEqual(ir.flowId, 'flow_abcdef0123');
      assert.equal(ir.intent, intent);
      assert.equal(ir.oracle, 'regression-lock');
    } finally {
      removeTempDir(tmp);
    }
  });

  it('still rejects a response whose stages are empty', async () => {
    const tmp = createTempDir();
    try {
      setupCartFixture(tmp);

      const modelIr: any = createValidModelIr();
      modelIr.stages = [];

      const model: ModelClient = {
        async complete() {
          return JSON.stringify(modelIr);
        },
      };

      await assert.rejects(
        compileIntent({ projectRoot: tmp, intent: '购物车去结算并支付成功', model }),
        /IR compilation failed/,
      );
    } finally {
      removeTempDir(tmp);
    }
  });
  it('puts the routeFlow pages and their elements into the payload', async () => {
    const tmp = createTempDir();
    try {
      setupCartFixture(tmp);

      let captured = '';
      const model: ModelClient = {
        async complete(req) {
          captured = req.messages[0].content;
          return JSON.stringify(createValidModelIr());
        },
      };

      await compileIntent({ projectRoot: tmp, intent: '购物车去结算并支付成功', model });

      const payload = JSON.parse(captured);
      assert.ok(Array.isArray(payload.pages), 'payload must carry pages');
      assert.deepEqual(
        payload.pages.map((page: any) => page.route),
        payload.routeFlow,
        'pages must cover exactly the routeFlow, in order',
      );
      for (const page of payload.pages) {
        assert.ok('title' in page && 'semanticKeywords' in page && 'elements' in page);
      }
    } finally {
      removeTempDir(tmp);
    }
  });

  it('tells the model which fields the engine authors and how to shape a stage', () => {
    assert.match(IR_SYSTEM_PROMPT, /flowId/);
    assert.match(IR_SYSTEM_PROMPT, /targetRole/);
    for (const role of ['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'heading', 'tab']) {
      assert.ok(IR_SYSTEM_PROMPT.includes(role), `prompt must list role ${role}`);
    }
    for (const action of ['CLICK', 'FILL', 'SELECT', 'CHECK']) {
      assert.ok(IR_SYSTEM_PROMPT.includes(action), `prompt must list action ${action}`);
    }
    // 纯导航用例必须是合法形态，否则 90 条无出边路由永远产不出 spec
    assert.match(IR_SYSTEM_PROMPT, /actions/);
    assert.match(IR_SYSTEM_PROMPT, /unresolved/);
    // readyRole/readyName 必须和 targetName 受同样约束，否则模型会拿页面标题顶替
    assert.match(IR_SYSTEM_PROMPT, /readyRole and readyName are under the SAME rule/);
    assert.match(IR_SYSTEM_PROMPT, /omit readyRole and readyName entirely/);
  });
  it('extracts the topology with the globs handed in by the caller', async () => {
    const tmp = createTempDir();
    try {
      setupCartFixture(tmp);
      // 项目根下没有 idt.config.ts —— 多项目模式里配置只在 IDT 根。
      // 不把 globs 传进来，提取就会回落到默认值，扫不到 src/pages 以外的东西。
      assert.equal(fs.existsSync(path.join(tmp, 'idt.config.ts')), false);

      const model: ModelClient = {
        async complete() {
          return JSON.stringify(createValidModelIr());
        },
      };

      const ir = await compileIntent({
        projectRoot: tmp,
        intent: '购物车去结算并支付成功',
        model,
        extract: {
          config: {
            pageGlobs: ['src/pages/**/*.{tsx,jsx,ts,js,vue}'],
            routerGlobs: [],
            localeFiles: [],
          },
          projectName: 'shop',
        },
      });

      assert.equal(ir.initialRoute, '/cart');
      const topo = JSON.parse(
        fs.readFileSync(path.join(tmp, '.idt', 'topology.json'), 'utf8'),
      );
      assert.equal(topo.project, 'shop');
      assert.ok(topo.routes['/cart'], 'the handed-in globs must be the ones used');
    } finally {
      removeTempDir(tmp);
    }
  });
});
