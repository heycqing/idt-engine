import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { generateFlow } from './generate.js';
import { emitSpec } from './emitter.js';
import { flowIdFromIntent } from './intent.js';
import type { ModelClient } from './ir-compiler.js';

function createTempDir(prefix = 'idt-gen-test-'): string {
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

describe('generateFlow', () => {
  it('Requirement 1: without yes -> .ir.json and .spec.ts exist, spec equals emitSpec, runSpec not called, exitCode 0, log contains oracle and stages and .spec.ts', async () => {
    const tmp = createTempDir();
    try {
      setupCartFixture(tmp);

      let runSpecCallCount = 0;
      const mockRunSpec = async () => {
        runSpecCallCount++;
        return { exitCode: 0, report: null };
      };

      const model: ModelClient = {
        async complete() {
          return JSON.stringify(createValidModelIr());
        },
      };

      const logs: string[] = [];
      const intent = '购物车去结算并支付成功';
      const expectedFlowId = flowIdFromIntent(intent);

      const result = await generateFlow({
        projectRoot: tmp,
        intent,
        model,
        runSpec: mockRunSpec,
        log: (line) => logs.push(line),
      });

      assert.equal(result.exitCode, 0);
      assert.equal(runSpecCallCount, 0);

      const genDir = path.join(tmp, 'tests/e2e/generated');
      const irFile = path.join(genDir, `${expectedFlowId}.ir.json`);
      const specFile = path.join(genDir, `${expectedFlowId}.spec.ts`);

      assert.ok(fs.existsSync(irFile), 'IR file should exist');
      assert.ok(fs.existsSync(specFile), 'spec.ts should exist');
      assert.equal(result.specPath, specFile);

      const savedIr = JSON.parse(fs.readFileSync(irFile, 'utf8'));
      const savedSpec = fs.readFileSync(specFile, 'utf8');
      const expectedSpec = emitSpec(savedIr);
      assert.equal(savedSpec, expectedSpec);

      assert.ok(logs.includes('oracle: regression-lock'), 'Logs should contain oracle: regression-lock');
      assert.ok(logs.includes('stage 0 /cart'), 'Logs should contain stage 0 /cart');
      assert.ok(logs.includes('stage 1 /checkout'), 'Logs should contain stage 1 /checkout');
      assert.ok(logs.includes('stage 2 /checkout/success'), 'Logs should contain stage 2 /checkout/success');
      assert.ok(logs.some((l) => l.includes('.spec.ts')), 'Logs should contain a line with .spec.ts');
    } finally {
      removeTempDir(tmp);
    }
  });

  it('Requirement 2: with proseCase -> logs contain oracle: prose-case, IR oracle is prose-case', async () => {
    const tmp = createTempDir();
    try {
      setupCartFixture(tmp);

      const model: ModelClient = {
        async complete() {
          return JSON.stringify(createValidModelIr());
        },
      };

      const logs: string[] = [];
      const intent = '购物车去结算并支付成功';
      const proseCase = '用户在购物车点击去结算，随后完成支付';
      const expectedFlowId = flowIdFromIntent(intent);

      const result = await generateFlow({
        projectRoot: tmp,
        intent,
        proseCase,
        model,
        log: (line) => logs.push(line),
      });

      assert.equal(result.exitCode, 0);
      assert.ok(logs.includes('oracle: prose-case'), 'Logs should contain oracle: prose-case');

      const irFile = path.join(tmp, 'tests/e2e/generated', `${expectedFlowId}.ir.json`);
      const savedIr = JSON.parse(fs.readFileSync(irFile, 'utf8'));
      assert.equal(savedIr.oracle, 'prose-case');
    } finally {
      removeTempDir(tmp);
    }
  });

  it('Requirement 3: yes: true and runSpec returning exitCode 0 -> runSpec receives specPath, callCount 1, returns 0', async () => {
    const tmp = createTempDir();
    try {
      setupCartFixture(tmp);

      let runSpecCallCount = 0;
      let receivedSpecPath = '';
      const mockRunSpec = async (specPath: string) => {
        runSpecCallCount++;
        receivedSpecPath = specPath;
        return { exitCode: 0, report: null };
      };

      const model: ModelClient = {
        async complete() {
          return JSON.stringify(createValidModelIr());
        },
      };

      const intent = '购物车去结算并支付成功';
      const expectedFlowId = flowIdFromIntent(intent);
      const expectedSpecPath = path.join(tmp, 'tests/e2e/generated', `${expectedFlowId}.spec.ts`);

      const result = await generateFlow({
        projectRoot: tmp,
        intent,
        model,
        yes: true,
        runSpec: mockRunSpec,
      });

      assert.equal(runSpecCallCount, 1);
      assert.equal(receivedSpecPath, expectedSpecPath);
      assert.equal(result.exitCode, 0);
      assert.equal(result.specPath, expectedSpecPath);
    } finally {
      removeTempDir(tmp);
    }
  });

  it('Requirement 4: yes: true and runSpec returning exitCode 1 -> generateFlow returns 1, both files remain on disk, spec content unchanged', async () => {
    const tmp = createTempDir();
    try {
      setupCartFixture(tmp);

      let runSpecCallCount = 0;
      const mockRunSpec = async () => {
        runSpecCallCount++;
        return { exitCode: 1, report: null };
      };

      const model: ModelClient = {
        async complete() {
          return JSON.stringify(createValidModelIr());
        },
      };

      const intent = '购物车去结算并支付成功';
      const expectedFlowId = flowIdFromIntent(intent);

      const result = await generateFlow({
        projectRoot: tmp,
        intent,
        model,
        yes: true,
        runSpec: mockRunSpec,
      });

      assert.equal(runSpecCallCount, 1);
      assert.equal(result.exitCode, 1);

      const genDir = path.join(tmp, 'tests/e2e/generated');
      const irFile = path.join(genDir, `${expectedFlowId}.ir.json`);
      const specFile = path.join(genDir, `${expectedFlowId}.spec.ts`);

      assert.ok(fs.existsSync(irFile), 'IR file should remain on disk');
      assert.ok(fs.existsSync(specFile), 'spec.ts should remain on disk');

      const savedIr = JSON.parse(fs.readFileSync(irFile, 'utf8'));
      const savedSpec = fs.readFileSync(specFile, 'utf8');
      assert.equal(savedSpec, emitSpec(savedIr));
    } finally {
      removeTempDir(tmp);
    }
  });

  it('Requirement 5: second call without force throws with exitCode 2, first spec bytes unchanged', async () => {
    const tmp = createTempDir();
    try {
      setupCartFixture(tmp);

      const model: ModelClient = {
        async complete() {
          return JSON.stringify(createValidModelIr());
        },
      };

      const intent = '购物车去结算并支付成功';
      const expectedFlowId = flowIdFromIntent(intent);
      const specFile = path.join(tmp, 'tests/e2e/generated', `${expectedFlowId}.spec.ts`);

      const res1 = await generateFlow({
        projectRoot: tmp,
        intent,
        model,
      });
      assert.equal(res1.exitCode, 0);

      const initialSpecBytes = fs.readFileSync(specFile);

      await assert.rejects(
        async () => {
          await generateFlow({
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

      const afterSpecBytes = fs.readFileSync(specFile);
      assert.deepEqual(afterSpecBytes, initialSpecBytes);
    } finally {
      removeTempDir(tmp);
    }
  });

  it('Requirement 6: same directory with force: true overwrites and spec equals emitSpec', async () => {
    const tmp = createTempDir();
    try {
      setupCartFixture(tmp);

      const model: ModelClient = {
        async complete() {
          return JSON.stringify(createValidModelIr());
        },
      };

      const intent = '购物车去结算并支付成功';
      const expectedFlowId = flowIdFromIntent(intent);
      const specFile = path.join(tmp, 'tests/e2e/generated', `${expectedFlowId}.spec.ts`);
      const irFile = path.join(tmp, 'tests/e2e/generated', `${expectedFlowId}.ir.json`);

      await generateFlow({
        projectRoot: tmp,
        intent,
        model,
      });

      const resForce = await generateFlow({
        projectRoot: tmp,
        intent,
        model,
        force: true,
      });

      assert.equal(resForce.exitCode, 0);
      assert.ok(fs.existsSync(specFile));
      assert.ok(fs.existsSync(irFile));

      const savedIr = JSON.parse(fs.readFileSync(irFile, 'utf8'));
      const savedSpec = fs.readFileSync(specFile, 'utf8');
      assert.equal(savedSpec, emitSpec(savedIr));
    } finally {
      removeTempDir(tmp);
    }
  });
});

describe('CLI Integration', () => {
  const projectRoot = process.cwd();
  const cliPath = path.resolve(projectRoot, 'scripts/idt/cli.ts');

  it('Requirement 1: gen <intent> --yes without OPENAI_API_KEY exits with code 2, output contains OPENAI_API_KEY, does not contain playwright test', () => {
    const res = spawnSync(
      process.execPath,
      ['--import', 'tsx', cliPath, 'gen', '测试意图', '--yes'],
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
    assert.ok(combinedOutput.includes('OPENAI_API_KEY'), `Output should contain OPENAI_API_KEY, got: ${combinedOutput}`);
    assert.ok(!combinedOutput.includes('playwright test'), `Output should not contain playwright test, got: ${combinedOutput}`);
  });

  it('Requirement 2: gen <intent> --case <non-existent> with arbitrary non-empty OPENAI_API_KEY exits with code 2 before model call', () => {
    const nonExistentPath = path.resolve(projectRoot, 'non-existent-case-file-xyz.txt');
    const res = spawnSync(
      process.execPath,
      ['--import', 'tsx', cliPath, 'gen', '测试意图', '--case', nonExistentPath],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          OPENAI_API_KEY: 'mock-key-for-test',
        },
        encoding: 'utf8',
      }
    );

    assert.equal(res.status, 2);
    const combinedOutput = `${res.stdout || ''}\n${res.stderr || ''}`;
    assert.ok(combinedOutput.includes('Case file not found'), `Output should indicate missing case file, got: ${combinedOutput}`);
  });

  it('Requirement 3: executing cli.ts without subcommands exits with non-zero code, does not compile any subcommand as intent', () => {
    const res = spawnSync(
      process.execPath,
      ['--import', 'tsx', cliPath],
      {
        cwd: projectRoot,
        encoding: 'utf8',
      }
    );

    assert.notEqual(res.status, 0, 'Exit code should be non-zero');
    const combinedOutput = `${res.stdout || ''}\n${res.stderr || ''}`;
    assert.ok(!combinedOutput.includes('flow_'), 'Should not compile intent or generate flow id');
    assert.ok(!combinedOutput.includes('compileIntent'), 'Should not invoke compileIntent');
  });
});

describe('Playwright Configuration', () => {
  it('playwright.idt.config.ts content assertions and dynamic import', async () => {
    const configPath = path.resolve(process.cwd(), 'playwright.idt.config.ts');
    assert.ok(fs.existsSync(configPath), 'playwright.idt.config.ts must exist');

    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('retries: 0'), 'Must contain retries: 0');
    assert.ok(content.includes('pnpm start'), 'Must contain pnpm start');
    assert.ok(content.includes('pnpm dev'), 'Must contain pnpm dev');
    assert.ok(content.includes('only-on-failure'), 'Must contain only-on-failure');

    const forbiddenTokens = [
      'networkidle',
      'toHaveScreenshot',
      'waitForTimeout',
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'IDT_MODEL_NAME',
    ];
    for (const token of forbiddenTokens) {
      assert.ok(!content.includes(token), `Must not contain forbidden token: ${token}`);
    }

    const origCI = process.env.CI;
    delete process.env.CI;
    try {
      const configModule = await import(pathToFileURL(configPath).href);
      const config = configModule.default;
      assert.equal(config.retries, 0, 'Config retries must be 0');
      assert.ok(
        typeof config.testDir === 'string' && config.testDir.includes('tests/e2e/generated'),
        'testDir must include tests/e2e/generated'
      );
    } finally {
      if (origCI !== undefined) {
        process.env.CI = origCI;
      } else {
        delete process.env.CI;
      }
    }
  });
});

describe('GitHub Actions and .gitattributes', () => {
  it('workflow idt-e2e.yml and .gitattributes meet requirements', () => {
    const workflowPath = path.resolve(process.cwd(), '.github/workflows/idt-e2e.yml');
    assert.ok(fs.existsSync(workflowPath), 'Workflow file must exist');

    const workflowContent = fs.readFileSync(workflowPath, 'utf8');
    assert.ok(workflowContent.includes('pnpm test:e2e'), 'Workflow must contain pnpm test:e2e');
    assert.ok(workflowContent.includes('timeout-minutes: 20'), 'Workflow must contain timeout-minutes: 20');
    assert.ok(workflowContent.includes('frozen-lockfile'), 'Workflow must contain frozen-lockfile');

    const forbiddenSecretTokens = [
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'IDT_MODEL_NAME',
    ];
    for (const token of forbiddenSecretTokens) {
      assert.ok(!workflowContent.includes(token), `Workflow must not contain secret token: ${token}`);
    }

    assert.ok(!/\bnpm\s/.test(workflowContent), 'Workflow must not contain standalone npm command');
    assert.ok(!workflowContent.includes('continue-on-error'), 'Workflow must not contain continue-on-error');
    assert.ok(!workflowContent.includes('\r'), 'Workflow must not contain CR (\\r)');

    const gitattributesPath = path.resolve(process.cwd(), '.gitattributes');
    assert.ok(fs.existsSync(gitattributesPath), '.gitattributes must exist');

    const gitattributesContent = fs.readFileSync(gitattributesPath, 'utf8');
    assert.ok(gitattributesContent.includes('eol=lf'), '.gitattributes must contain eol=lf');
    assert.ok(gitattributesContent.includes('*.png binary'), '.gitattributes must contain *.png binary');
    assert.ok(!gitattributesContent.includes('\r'), '.gitattributes must not contain CR (\\r)');
  });
});
