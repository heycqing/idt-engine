import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runCommand,
  playwrightTestInvocation,
  runPlaywrightSpec,
  RunnerError,
} from './runner.js';

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

  it('playwrightTestInvocation returns pnpm invocation without npm in args', () => {
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
});
