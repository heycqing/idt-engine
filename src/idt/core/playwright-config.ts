import fs from 'node:fs';
import path from 'node:path';
import type { IdtProject } from '../config/projects.js';

/** 生成在 <项目根>/.idt/ 下，是产物不是源码，随 sync 重写。 */
export const PROJECT_PLAYWRIGHT_CONFIG = 'playwright.config.ts';

export function projectBaseUrl(
  project: IdtProject,
  processEnv: NodeJS.ProcessEnv = process.env,
): string {
  if (processEnv.IDT_BASE_URL) return processEnv.IDT_BASE_URL;
  const port = Number(processEnv.IDT_PORT || project.port);
  return `http://127.0.0.1:${port}`;
}

export function renderProjectPlaywrightConfig(project: IdtProject): string {
  const webServer = project.devCommand
    ? `
  webServer: {
    command: ${JSON.stringify(project.devCommand).replace(/"/g, "'")},
    // Playwright 默认把 cwd 设成配置文件所在目录，也就是 .idt/，
    // 启动命令在那里跑找不到项目的 package.json。回到项目根。
    cwd: '..',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },`
    : '';

  return `// 由 idt:sync 生成，IDT 项目 "${project.name}"。改这个文件没有意义，下次 sync 会覆盖。
// 端口和启动命令来自该项目 package.json 的 idt 标志（port / devCommand）。
import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.IDT_PORT || ${project.port});
const baseURL = process.env.IDT_BASE_URL || \`http://127.0.0.1:\${port}\`;

export default defineConfig({
  // 相对本文件所在的 .idt/ 目录，回指项目根的 tests/e2e。
  // generated 子目录在内，手写的 fixture 和冒烟用例也在内。
  testDir: '../tests/e2e',
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['html'], ['github']] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'Desktop Chrome', use: { ...devices['Desktop Chrome'] } }],${webServer}
});
`;
}

export function writeProjectPlaywrightConfig(project: IdtProject): string {
  const idtDir = path.resolve(project.root, '.idt');
  fs.mkdirSync(idtDir, { recursive: true });
  const target = path.join(idtDir, PROJECT_PLAYWRIGHT_CONFIG);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, renderProjectPlaywrightConfig(project), 'utf8');
  if (fs.existsSync(target)) fs.unlinkSync(target);
  fs.renameSync(tmp, target);
  return target;
}
