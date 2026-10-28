import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PROJECT_PLAYWRIGHT_CONFIG,
  projectBaseUrl,
  renderProjectPlaywrightConfig,
  writeProjectPlaywrightConfig,
} from '../../../src/idt/core/playwright-config.js';
import type { IdtProject } from '../../../src/idt/config/projects.js';

function project(overrides: Partial<IdtProject> = {}): IdtProject {
  return {
    name: 'caida',
    root: path.resolve('/workspace/apps/caida'),
    implicit: false,
    pageGlobs: [],
    routerGlobs: [],
    localeFiles: [],
    deferredContainers: [],
    devCommand: 'pnpm dev:cd',
    port: 8080,
    ...overrides,
  };
}

describe('project playwright config', () => {
  it('renders the project dev command and port', () => {
    const source = renderProjectPlaywrightConfig(project());
    assert.match(source, /const port = Number\(process\.env\.IDT_PORT \|\| 8080\)/);
    assert.match(source, /command: 'pnpm dev:cd'/);
    // 生成物在 <项目根>/.idt/ 下，testDir 要回指项目根的 tests/e2e
    assert.match(source, /testDir: '\.\.\/tests\/e2e'/);
    assert.match(source, /@playwright\/test/);
  });

  it('runs webServer in the project root, not in .idt', () => {
    // Playwright 的 webServer.cwd 默认是配置文件所在目录，而生成的配置就放在
    // .idt/ 下。不显式指定的话启动命令会在 .idt/ 里跑，pnpm 找不到脚本。
    const source = renderProjectPlaywrightConfig(project());
    assert.match(source, /cwd: *['"]\.\.['"]/);
  });

  it('waits long enough for a cold webpack build', () => {
    // 实测财达这种 vue-cli 4 应用冷编译就要两分多钟，180s 的窗口会超时，
    // 而且失败信息只说 Timed out，看不出是编译慢还是真起不来。
    const source = renderProjectPlaywrightConfig(project());
    const match = source.match(/webServer:[\s\S]*?timeout: ([0-9_]+)/);
    assert.ok(match, 'webServer 必须有 timeout');
    assert.ok(
      Number(match[1].replace(/_/g, '')) >= 300_000,
      `timeout 太短：${match[1]}`,
    );
  });

  it('tells the dev server which port to bind', () => {
    // 只在配置里写期待端口是不够的：vue-cli 发现端口忙会自增，
    // 于是配置等 8080、服务器起在 8081，必然超时。PORT 是 vue-cli、
    // next、vite 都认的约定。
    const source = renderProjectPlaywrightConfig(project());
    assert.match(source, /env: *\{[^}]*PORT: *String\(port\)/);
  });

  it('omits webServer when the project declares no dev command', () => {
    const source = renderProjectPlaywrightConfig(project({ devCommand: undefined }));
    assert.equal(source.includes('webServer'), false);
    assert.match(source, /baseURL/);
  });

  it('names the project in a comment so a stray file is identifiable', () => {
    assert.match(renderProjectPlaywrightConfig(project()), /caida/);
  });

  it('computes the base url with the env override winning', () => {
    assert.equal(projectBaseUrl(project()), 'http://127.0.0.1:8080');
    assert.equal(
      projectBaseUrl(project(), { IDT_BASE_URL: 'http://example.test' }),
      'http://example.test',
    );
    assert.equal(
      projectBaseUrl(project(), { IDT_PORT: '4321' }),
      'http://127.0.0.1:4321',
    );
  });

  it('writes the config next to the topology, overwriting a stale one', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idt-pw-'));
    try {
      const target = writeProjectPlaywrightConfig(project({ root }));
      assert.equal(target, path.join(root, '.idt', PROJECT_PLAYWRIGHT_CONFIG));
      assert.match(fs.readFileSync(target, 'utf8'), /pnpm dev:cd/);

      const again = writeProjectPlaywrightConfig(
        project({ root, devCommand: 'pnpm dev:yk', port: 9100 }),
      );
      const text = fs.readFileSync(again, 'utf8');
      assert.match(text, /pnpm dev:yk/);
      assert.equal(text.includes('pnpm dev:cd'), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
