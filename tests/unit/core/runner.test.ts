import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runCommand,
  playwrightCliEntry,
  playwrightTestInvocation,
  runPlaywrightSpec,
  RunnerError,
} from '../../../src/idt/core/runner.js';

describe('runner', () => {
  it('runCommand captures stdout, stderr and exitCode accurately', async () => {
    const code =
      process.platform === 'win32'
        ? '"process.stdout.write(\\"out\\"); process.stderr.write(\\"err\\"); process.exit(3);"'
        : 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3);';
    const result = await runCommand(process.execPath, ['-e', code]);
    assert.equal(result.exitCode, 3);
    assert.ok(result.stdout.includes('out'));
    assert.ok(result.stderr.includes('err'));
    assert.ok(!result.stdout.includes('err'));
  });

  it('runCommand ensures FORCE_COLOR is set to 0 in environment', async () => {
    const code =
      process.platform === 'win32'
        ? '"process.stdout.write(process.env.FORCE_COLOR || \\"\\");"'
        : 'process.stdout.write(process.env.FORCE_COLOR || "");';
    const result = await runCommand(process.execPath, ['-e', code], {
      env: { FORCE_COLOR: '1' },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), '0');
  });

  it('playwrightTestInvocation falls back to the legacy root config', () => {
    const invocation = playwrightTestInvocation('tests/e2e/test.spec.ts');
    assert.equal(invocation.command, 'pnpm');
    assert.deepEqual(invocation.args, [
      'exec',
      'playwright',
      'test',
      'tests/e2e/test.spec.ts',
      '--config=playwright.idt.config.ts',
      '--reporter=json',
    ]);
    assert.ok(!invocation.args.includes('npm'));
  });

  it('playwrightTestInvocation prefers the generated per-project config', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idt-runner-cfg-'));
    try {
      fs.mkdirSync(path.join(tempDir, '.idt'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, '.idt', 'playwright.config.ts'), '// generated', 'utf8');

      const invocation = playwrightTestInvocation('tests/e2e/test.spec.ts', tempDir);
      assert.ok(
        invocation.args.includes('--config=.idt/playwright.config.ts'),
        `expected the generated config, got ${invocation.args.join(' ')}`,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runPlaywrightSpec passes expected parameters to injected spawnImpl', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idt-runner-'));
    try {
      let recordedCommand = '';
      let recordedArgs: string[] = [];
      let recordedCwd: string | undefined = '';
      let recordedEnv: NodeJS.ProcessEnv | undefined = {};

      const mockSpawn = async (
        cmd: string,
        args: string[],
        options?: { cwd?: string; env?: NodeJS.ProcessEnv },
      ) => {
        recordedCommand = cmd;
        recordedArgs = args;
        recordedCwd = options?.cwd;
        recordedEnv = options?.env;

        const idtDir = path.join(tempDir, '.idt');
        fs.writeFileSync(
          path.join(idtDir, 'last-report.json'),
          JSON.stringify({ status: 'passed' }),
          'utf8',
        );

        return { exitCode: 0, stdout: '', stderr: '' };
      };

      const specPath = 'tests/e2e/generated/flow_1.spec.ts';
      const res = await runPlaywrightSpec(specPath, tempDir, mockSpawn);

      assert.equal(recordedCommand, 'pnpm');
      assert.deepEqual(
        recordedArgs,
        playwrightTestInvocation(specPath).args,
      );
      assert.equal(recordedCwd, tempDir);
      assert.equal(
        recordedEnv?.PLAYWRIGHT_JSON_OUTPUT_NAME,
        '.idt/last-report.json',
      );
      assert.equal(recordedEnv?.FORCE_COLOR, '0');
      assert.equal(res.exitCode, 0);
      assert.deepEqual(res.report, { status: 'passed' });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runPlaywrightSpec returns report null when report file does not exist', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idt-runner-'));
    try {
      const mockSpawn = async () => {
        return { exitCode: 1, stdout: '', stderr: '' };
      };
      const res = await runPlaywrightSpec('dummy.spec.ts', tempDir, mockSpawn);
      assert.equal(res.exitCode, 1);
      assert.equal(res.report, null);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runPlaywrightSpec throws exitCode 2 when report JSON is malformed', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idt-runner-'));
    try {
      const mockSpawn = async () => {
        const idtDir = path.join(tempDir, '.idt');
        fs.writeFileSync(
          path.join(idtDir, 'last-report.json'),
          'invalid json content',
          'utf8',
        );
        return { exitCode: 1, stdout: '', stderr: '' };
      };

      await assert.rejects(
        async () => {
          await runPlaywrightSpec('dummy.spec.ts', tempDir, mockSpawn);
        },
        (err: any) => {
          assert.equal(err.exitCode, 2);
          return true;
        },
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
  it('runs the resolved playwright cli directly instead of going through pnpm', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idt-runner-cli-'));
    try {
      const cliDir = path.join(tempDir, 'node_modules', 'playwright');
      fs.mkdirSync(cliDir, { recursive: true });
      const cliJs = path.join(cliDir, 'cli.js');
      fs.writeFileSync(cliJs, '// fake', 'utf8');

      assert.equal(playwrightCliEntry(tempDir), cliJs);

      const invocation = playwrightTestInvocation('tests/e2e/a.spec.ts', tempDir);
      assert.equal(invocation.command, process.execPath);
      assert.equal(invocation.args[0], cliJs);
      assert.equal(invocation.args[1], 'test');
      assert.ok(!invocation.args.includes('pnpm'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('finds the playwright cli hoisted above the project root', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idt-runner-up-'));
    try {
      const cliDir = path.join(tempDir, 'node_modules', 'playwright');
      fs.mkdirSync(cliDir, { recursive: true });
      fs.writeFileSync(path.join(cliDir, 'cli.js'), '// fake', 'utf8');
      const nested = path.join(tempDir, 'apps', 'caida');
      fs.mkdirSync(nested, { recursive: true });

      assert.equal(playwrightCliEntry(nested), path.join(cliDir, 'cli.js'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('falls back to pnpm exec when playwright cannot be resolved', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idt-runner-none-'));
    try {
      assert.equal(playwrightCliEntry(tempDir), null);
      assert.equal(playwrightTestInvocation('a.spec.ts', tempDir).command, 'pnpm');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
