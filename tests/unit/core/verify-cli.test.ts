import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { emitSpec } from '../../../src/idt/core/emitter.js';
import type { StateTransitionIR } from '../../../src/idt/core/ir-schema.js';

const cliPath = path.resolve('scripts/idt/cli.ts');
const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

function withProject(
  run: (root: string) => void,
  config: (root: string) => Record<string, unknown> = () => ({}),
): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idt-verify-cli-'));
  try {
    fs.writeFileSync(
      path.join(root, 'idt.config.ts'),
      `export default ${JSON.stringify({
        pageGlobs: ['src/pages/**/*.tsx'], routerGlobs: [], localeFiles: [],
        ...config(root),
      })};`,
      'utf8',
    );
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runVerify(root: string, ...args: string[]) {
  return spawnSync(
    process.execPath,
    ['--import', tsxImport, cliPath, 'verify', ...args],
    { cwd: root, encoding: 'utf8' },
  );
}

/** 与 withProject 的空源树 + pageGlobs 对应的 inputsDigest（无命中文件）。 */
const EMPTY_INPUTS_DIGEST =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function writeTopology(
  root: string,
  overrides: Record<string, unknown> = {},
): void {
  fs.mkdirSync(path.join(root, '.idt'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.idt', 'topology.json'),
    JSON.stringify({
      routes: { '/home': { elements: [] } },
      generatedAt: '2026-10-27T02:06:00.000Z',
      inputsDigest: EMPTY_INPUTS_DIGEST,
      ...overrides,
    }),
    'utf8',
  );
}

function writeWeakCase(root: string): void {
  const generated = path.join(root, 'tests', 'e2e', 'generated');
  fs.mkdirSync(generated, { recursive: true });
  const ir: StateTransitionIR = {
    flowId: 'flow_aabbccddee',
    intent: '打开首页',
    oracle: 'regression-lock',
    description: '首页 URL 正确',
    initialRoute: '/home',
    setup: { notes: [] },
    unresolved: [],
    stages: [{
      stageIndex: 0,
      stageName: '首页',
      routePattern: '/home',
      actions: [],
      invariants: { network: [], routeGuard: { targetUrlPattern: '/home' } },
    }],
  };
  fs.writeFileSync(path.join(generated, `${ir.flowId}.ir.json`), JSON.stringify(ir), 'utf8');
  fs.writeFileSync(path.join(generated, `${ir.flowId}.spec.ts`), emitSpec(ir), 'utf8');
}

const warningException = (project: string) => ({
  project,
  flowId: 'flow_aabbccddee',
  code: 'weak-assertion',
  reason: 'M3 negative control',
});

describe('idt verify CLI', () => {
  it('allows an exact project warning exception in strict mode and prints its reason', () => {
    withProject((root) => {
      writeTopology(root);
      writeWeakCase(root);

      const strict = runVerify(root, '--strict');

      assert.equal(strict.status, 0, strict.stderr || strict.stdout);
      assert.match(strict.stdout, /豁免警告/);
      assert.match(strict.stdout, /M3 negative control/);
      assert.match(strict.stdout, /0 个错误，0 个警告，共 1 条用例/);
      assert.match(strict.stdout, /1 个豁免警告/);
    }, (root) => ({ verifyWarningExceptions: [warningException(path.basename(root))] }));
  });

  it('keeps strict verification failing when the exception belongs to another project', () => {
    withProject((root) => {
      writeTopology(root);
      writeWeakCase(root);

      const strict = runVerify(root, '--strict');

      assert.equal(strict.status, 1, strict.stderr);
      assert.match(strict.stdout, /0 个错误，1 个警告，共 1 条用例/);
      assert.doesNotMatch(strict.stdout, /M3 negative control/);
    }, () => ({ verifyWarningExceptions: [warningException('other')] }));
  });

  it('keeps errors failing when a warning is exempted', () => {
    withProject((root) => {
      writeTopology(root);
      writeWeakCase(root);
      fs.writeFileSync(path.join(root, 'tests/e2e/generated/orphan.spec.ts'), '// orphan', 'utf8');

      const strict = runVerify(root, '--strict');

      assert.equal(strict.status, 1, strict.stderr);
      assert.match(strict.stdout, /1 个错误，0 个警告，共 1 条用例/);
      assert.match(strict.stdout, /M3 negative control/);
    }, (root) => ({ verifyWarningExceptions: [warningException(path.basename(root))] }));
  });

  it('returns exit code 2 when the topology is missing', () => {
    withProject((root) => {
      const result = runVerify(root);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /还没有拓扑，先执行 idt:sync/);
    });
  });

  it('reports an orphan spec as an error without counting it as a case', () => {
    withProject((root) => {
      writeTopology(root);
      const generated = path.join(root, 'tests', 'e2e', 'generated');
      fs.mkdirSync(generated, { recursive: true });
      fs.writeFileSync(path.join(generated, 'orphan.spec.ts'), '// orphan', 'utf8');

      const result = runVerify(root);

      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stdout, /孤立/);
      assert.match(result.stdout, /1 个错误，0 个警告，共 0 条用例/);
    });
  });

  it('only fails warning-only results when --strict is present', () => {
    withProject((root) => {
      writeTopology(root);
      const generated = path.join(root, 'tests', 'e2e', 'generated');
      fs.mkdirSync(generated, { recursive: true });
      const ir: StateTransitionIR = {
        flowId: 'flow_aabbccddee',
        intent: '打开首页',
        oracle: 'regression-lock',
        description: '首页 URL 正确',
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
              network: [],
              routeGuard: { targetUrlPattern: '/home' },
            },
          },
        ],
      };
      fs.writeFileSync(
        path.join(generated, `${ir.flowId}.ir.json`),
        JSON.stringify(ir),
        'utf8',
      );
      fs.writeFileSync(
        path.join(generated, `${ir.flowId}.spec.ts`),
        emitSpec(ir),
        'utf8',
      );

      const normal = runVerify(root);
      const strict = runVerify(root, '--strict');

      assert.equal(normal.status, 0, normal.stderr);
      assert.equal(strict.status, 1, strict.stderr);
      assert.match(normal.stdout, /0 个错误，1 个警告，共 1 条用例/);
    });
  });

  // verify 的职责是发现 IR 有问题，所以坏 IR 必须变成 finding，不能把命令打崩。
  // unresolved 在 schema 里带 .default([])，输入可以缺省——裸 JSON.parse 读到
  // undefined，后面一取 .length 就是 TypeError。
  it('turns an IR that fails schema validation into a finding instead of crashing', () => {
    withProject((root) => {
      writeTopology(root);
      const generated = path.join(root, 'tests', 'e2e', 'generated');
      fs.mkdirSync(generated, { recursive: true });
      fs.writeFileSync(
        path.join(generated, 'flow_aabbccddee.ir.json'),
        JSON.stringify({
          flowId: 'flow_aabbccddee',
          intent: '打开首页',
          oracle: 'regression-lock',
          description: '首页',
          initialRoute: '/home',
          stages: [],
        }),
        'utf8',
      );

      const result = runVerify(root);

      assert.equal(result.status, 1, result.stderr);
      assert.doesNotMatch(result.stderr, /Cannot read properties/);
      assert.match(result.stdout, /不符合 IR schema/);
      assert.match(result.stdout, /1 个错误，0 个警告，共 0 条用例/);
    });
  });

  it('reports unreadable JSON as a finding too', () => {
    withProject((root) => {
      writeTopology(root);
      const generated = path.join(root, 'tests', 'e2e', 'generated');
      fs.mkdirSync(generated, { recursive: true });
      fs.writeFileSync(path.join(generated, 'flow_aabbccddee.ir.json'), '{ 坏', 'utf8');

      const result = runVerify(root);

      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stdout, /读不出合法 JSON/);
    });
  });

  it('reports stale-topology as an error when inputsDigest no longer matches', () => {
    withProject((root) => {
      writeTopology(root, { inputsDigest: 'a'.repeat(64) });
      const generated = path.join(root, 'tests', 'e2e', 'generated');
      fs.mkdirSync(generated, { recursive: true });

      const result = runVerify(root);

      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stdout, /idt:sync/);
      assert.match(result.stdout, /2026-10-27T02:06:00\.000Z/);
      assert.match(result.stdout, /1 个错误，0 个警告，共 0 条用例/);
    });
  });

  it('warns when the topology omits inputsDigest', () => {
    withProject((root) => {
      writeTopology(root, { inputsDigest: undefined });
      // JSON.stringify drops undefined keys — simulate a legacy topology.
      fs.writeFileSync(
        path.join(root, '.idt', 'topology.json'),
        JSON.stringify({
          routes: { '/home': { elements: [] } },
          generatedAt: '2026-10-01T00:00:00.000Z',
        }),
        'utf8',
      );

      const result = runVerify(root);

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /旧版本|无法判断/);
      assert.match(result.stdout, /0 个错误，1 个警告，共 0 条用例/);
    });
  });
});
