import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore
import spawn from 'cross-spawn';

export class RunnerError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'RunnerError';
    this.exitCode = exitCode;
  }
}

export type SpawnFunction = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export function runCommand(
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(options?.env ?? {}),
      FORCE_COLOR: '0',
    };

    const child = spawn(command, args, {
      cwd: options?.cwd,
      env,
      shell: isWin,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data: Buffer | string) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data: Buffer | string) => {
      stderr += data.toString();
    });

    child.on('error', (err: Error) => {
      reject(err);
    });

    child.on('close', (code: number | null) => {
      resolve({
        exitCode: code === null ? 1 : code,
        stdout,
        stderr,
      });
    });
  });
}

export function playwrightTestInvocation(specPath: string): {
  command: string;
  args: string[];
} {
  return {
    command: 'pnpm',
    args: [
      'exec',
      'playwright',
      'test',
      specPath,
      '--config=playwright.idt.config.ts',
      '--reporter=json',
    ],
  };
}

export async function runPlaywrightSpec(
  specPath: string,
  projectRoot: string,
  spawnImpl: SpawnFunction = runCommand,
): Promise<{ exitCode: number; report: unknown | null }> {
  const idtDir = path.resolve(projectRoot, '.idt');
  if (!fs.existsSync(idtDir)) {
    fs.mkdirSync(idtDir, { recursive: true });
  }

  const invocation = playwrightTestInvocation(specPath);
  const spawnEnv: NodeJS.ProcessEnv = {
    ...process.env,
    FORCE_COLOR: '0',
    PLAYWRIGHT_JSON_OUTPUT_NAME: '.idt/last-report.json',
  };

  const result = await spawnImpl(invocation.command, invocation.args, {
    cwd: projectRoot,
    env: spawnEnv,
  });

  const reportPath = path.resolve(projectRoot, '.idt/last-report.json');
  if (!fs.existsSync(reportPath)) {
    return {
      exitCode: result.exitCode,
      report: null,
    };
  }

  const content = fs.readFileSync(reportPath, 'utf8');
  let report: unknown;
  try {
    report = JSON.parse(content);
  } catch (err: any) {
    throw new RunnerError(
      `Failed to parse Playwright JSON report: ${err.message}`,
      2,
    );
  }

  return {
    exitCode: result.exitCode,
    report,
  };
}
