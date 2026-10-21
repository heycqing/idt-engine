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
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(options?.env ?? {}),
      FORCE_COLOR: '0',
    };

    // 只有要靠 PATH 找的命令（pnpm 之类）才需要 Windows 的 shell。
    // 命令本身是绝对路径时走 shell 反而会因为引号/反斜杠处理失败（ENOENT）。
    const needsShell = process.platform === 'win32' && !path.isAbsolute(command);

    const child = spawn(command, args, {
      cwd: options?.cwd,
      env,
      shell: needsShell,
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

const GENERATED_CONFIG = '.idt/playwright.config.ts';
const LEGACY_CONFIG = 'playwright.idt.config.ts';

/**
 * 优先用 idt:sync 生成的按项目配置；宿主还停在老形态时回落到根上那份。
 */
export function playwrightConfigPath(projectRoot?: string): string {
  if (projectRoot) {
    const generated = path.resolve(projectRoot, ...GENERATED_CONFIG.split('/'));
    if (fs.existsSync(generated)) return GENERATED_CONFIG;
  }
  return LEGACY_CONFIG;
}

/**
 * 从 projectRoot 向上找 node_modules/playwright/cli.js。直接用 node 跑它，
 * 不经过 pnpm exec —— 包管理器本身出问题时不该把测试一起拖下水，
 * Windows 上也绕开了 .cmd/.ps1 shim。
 */
export function playwrightCliEntry(projectRoot: string): string | null {
  let current = path.resolve(projectRoot);
  for (;;) {
    const candidate = path.join(current, 'node_modules', 'playwright', 'cli.js');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function playwrightTestInvocation(
  specPath: string,
  projectRoot?: string,
): {
  command: string;
  args: string[];
} {
  const tail = [
    'test',
    specPath,
    `--config=${playwrightConfigPath(projectRoot)}`,
    '--reporter=json',
  ];

  const cli = projectRoot ? playwrightCliEntry(projectRoot) : null;
  if (cli) {
    return { command: process.execPath, args: [cli, ...tail] };
  }

  return { command: 'pnpm', args: ['exec', 'playwright', ...tail] };
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

  // Playwright 把位置参数当正则匹配文件路径，绝对 Windows 路径里的反斜杠和
  // 冒号不是合法正则，会匹配不到任何文件（报 No tests found）。
  const relativeSpec = path
    .relative(projectRoot, path.resolve(projectRoot, specPath))
    .split(path.sep)
    .join('/');

  const invocation = playwrightTestInvocation(relativeSpec, projectRoot);
  // 必须是绝对路径：生成的 Playwright 配置就放在 .idt/ 下，相对路径会被按
  // 配置文件所在目录解析，报告会落进 .idt/.idt/ 而读不回来。
  const reportPath = path.resolve(projectRoot, '.idt', 'last-report.json');
  const spawnEnv: NodeJS.ProcessEnv = {
    ...process.env,
    FORCE_COLOR: '0',
    PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath,
  };

  const result = await spawnImpl(invocation.command, invocation.args, {
    cwd: projectRoot,
    env: spawnEnv,
  });

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
