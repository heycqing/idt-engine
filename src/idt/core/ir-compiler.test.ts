import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { compileIntent, type ModelClient } from './ir-compiler.js';
import { flowIdFromIntent } from './intent.js';
import { OpenAiClient } from './openai-client.js';

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
});
