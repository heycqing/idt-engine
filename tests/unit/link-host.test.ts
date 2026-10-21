import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectPageGlobs,
  desiredScripts,
  linkHost,
  mergeGitignore,
  renderEnvExample,
  toPosixRelative,
} from '../../scripts/idt/link-host.mjs';

function tempHost(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'idt-link-host-'));
}

describe('link-host', () => {
  it('finds page directories and falls back when none exist', () => {
    const host = tempHost();
    try {
      assert.equal(detectPageGlobs(host).usedDefaults, true);
      fs.mkdirSync(path.join(host, 'src', 'pages'), { recursive: true });
      fs.mkdirSync(path.join(host, 'apps', 'web', 'src', 'views'), { recursive: true });
      const found = detectPageGlobs(host);
      assert.equal(found.usedDefaults, false);
      assert.ok(found.pageGlobs.includes('src/pages/**/*.{tsx,jsx,ts,js,vue}'));
      assert.ok(found.pageGlobs.includes('apps/web/src/views/**/*.{tsx,jsx,ts,js,vue}'));
    } finally {
      fs.rmSync(host, { recursive: true, force: true });
    }
  });

  it('builds a posix path from the host to the engine', () => {
    const rel = toPosixRelative('D:\\host', 'D:\\host\\idt-engine');
    assert.equal(rel.includes('\\'), false);
    assert.match(desiredScripts('./idt-engine')['idt:sync'], /tsx \.\/idt-engine\/scripts\/idt\/cli\.ts sync/);
  });

  it('appends gitignore entries once, including the project key file', () => {
    const first = mergeGitignore('node_modules/\n');
    assert.deepEqual(first.added, [
      '.env.idt.local',
      '.idt/',
      'test-results/',
      'playwright-report/',
      'blob-report/',
    ]);
    const second = mergeGitignore(first.text);
    assert.deepEqual(second.added, []);
  });

  it('renders an env template that carries no values', () => {
    const template = renderEnvExample();
    assert.match(template, /^OPENAI_API_KEY=$/m);
    assert.match(template, /^OPENAI_BASE_URL=$/m);
    assert.match(template, /^IDT_MODEL_NAME=$/m);
    for (const line of template.split('\n')) {
      if (line.includes('=') && !line.trim().startsWith('#')) {
        assert.equal(line.trim().endsWith('='), true, `template line carries a value: ${line}`);
      }
    }
  });

  it('writes host scripts and config without installing or adding a submodule', () => {
    const host = tempHost();
    const engineRoot = path.resolve('D:\\mine-prop\\idt-engine');
    try {
      fs.writeFileSync(
        path.join(host, 'package.json'),
        JSON.stringify({ name: 'host-app', scripts: { dev: 'vite', test: 'vitest' } }, null, 2),
        'utf8',
      );
      fs.writeFileSync(path.join(host, 'idt.config.ts'), 'export default { pageGlobs: ["keep"], localeFiles: [] };\n', 'utf8');
      const calls: string[] = [];
      const result = linkHost({
        hostRoot: host,
        engineRoot,
        noInstall: true,
        noSubmodule: true,
        run: () => {
          calls.push('run');
          return 0;
        },
      });
      assert.deepEqual(calls, []);
      assert.equal(result.configWritten, false);
      assert.equal(fs.readFileSync(path.join(host, 'idt.config.ts'), 'utf8').includes('keep'), true);
      const pkg = JSON.parse(fs.readFileSync(path.join(host, 'package.json'), 'utf8'));
      assert.equal(pkg.scripts.dev, 'vite');
      assert.match(
        pkg.scripts['idt:sync'],
        /^node .*node_modules\/tsx\/dist\/cli\.mjs .*scripts\/idt\/cli\.ts sync$/,
      );
      assert.equal(pkg.scripts['test:e2e'], 'playwright test --config=.idt/playwright.config.ts');
      // Playwright 配置由 idt:sync 按项目生成，接入脚本不再往宿主根写单租户那份
      assert.equal(fs.existsSync(path.join(host, 'playwright.idt.config.ts')), false);
      assert.match(fs.readFileSync(path.join(host, '.gitignore'), 'utf8'), /\.idt\//);
    } finally {
      fs.rmSync(host, { recursive: true, force: true });
    }
  });

  it('writes router globs for a newly linked Vue host', () => {
    const host = tempHost();
    const engineRoot = path.resolve('D:\\mine-prop\\idt-engine');
    try {
      fs.writeFileSync(
        path.join(host, 'package.json'),
        JSON.stringify({ name: 'vue-host', scripts: { dev: 'vue-cli-service serve' } }, null, 2),
        'utf8',
      );
      fs.mkdirSync(path.join(host, 'src', 'views', 'home'), { recursive: true });
      fs.mkdirSync(path.join(host, 'src', 'router'), { recursive: true });
      fs.writeFileSync(path.join(host, 'src', 'views', 'home', 'index.vue'), '<template />', 'utf8');
      fs.writeFileSync(path.join(host, 'src', 'router', 'index.js'), 'export default []', 'utf8');

      linkHost({
        hostRoot: host,
        engineRoot,
        noInstall: true,
        noSubmodule: true,
        run: () => 0,
      });

      const config = fs.readFileSync(path.join(host, 'idt.config.ts'), 'utf8');
      assert.match(config, /routerGlobs:/);
      assert.match(config, /src\/router\/\*\*\/\*\.\{js,ts\}/);
    } finally {
      fs.rmSync(host, { recursive: true, force: true });
    }
  });

  it('keeps an existing test:e2e script', () => {
    const host = tempHost();
    const engineRoot = path.resolve('D:\\mine-prop\\idt-engine');
    try {
      fs.writeFileSync(
        path.join(host, 'package.json'),
        JSON.stringify({ name: 'host-app', scripts: { start: 'node server.js', 'test:e2e': 'vitest e2e' } }, null, 2),
        'utf8',
      );
      linkHost({
        hostRoot: host,
        engineRoot,
        noInstall: true,
        noSubmodule: true,
        run: () => 0,
      });
      const pkg = JSON.parse(fs.readFileSync(path.join(host, 'package.json'), 'utf8'));
      assert.equal(pkg.scripts['test:e2e'], 'vitest e2e');
      assert.equal(pkg.scripts['test:idt:e2e'], 'playwright test --config=.idt/playwright.config.ts');
    } finally {
      fs.rmSync(host, { recursive: true, force: true });
    }
  });

  it('does not add test:idt:e2e when test:e2e is already the IDT command', () => {
    const host = tempHost();
    const engineRoot = path.resolve('D:\\mine-prop\\idt-engine');
    try {
      fs.writeFileSync(
        path.join(host, 'package.json'),
        JSON.stringify({ name: 'host-app', scripts: { dev: 'vite' } }, null, 2),
        'utf8',
      );
      const link = () =>
        linkHost({ hostRoot: host, engineRoot, noInstall: true, noSubmodule: true, run: () => 0 });

      link();
      link();

      const pkg = JSON.parse(fs.readFileSync(path.join(host, 'package.json'), 'utf8'));
      assert.equal(pkg.scripts['test:e2e'], 'playwright test --config=.idt/playwright.config.ts');
      assert.equal(pkg.scripts['test:idt:e2e'], undefined);
    } finally {
      fs.rmSync(host, { recursive: true, force: true });
    }
  });
  it('creates the env template without ever creating the key file', () => {
    const host = tempHost();
    const engineRoot = path.resolve('D:\\mine-prop\\idt-engine');
    try {
      fs.writeFileSync(
        path.join(host, 'package.json'),
        JSON.stringify({ name: 'host-app', scripts: { dev: 'vite' } }, null, 2),
        'utf8',
      );

      const first = linkHost({
        hostRoot: host,
        engineRoot,
        noInstall: true,
        noSubmodule: true,
        run: () => 0,
      });
      assert.equal(first.envExampleWritten, true);
      assert.equal(fs.existsSync(path.join(host, '.env.idt.local')), false);
      const template = fs.readFileSync(path.join(host, '.env.idt.example'), 'utf8');
      assert.match(template, /^OPENAI_API_KEY=$/m);
      assert.match(fs.readFileSync(path.join(host, '.gitignore'), 'utf8'), /^\.env\.idt\.local$/m);

      fs.writeFileSync(path.join(host, '.env.idt.example'), 'OPENAI_API_KEY=\n# edited by host\n', 'utf8');
      const second = linkHost({
        hostRoot: host,
        engineRoot,
        noInstall: true,
        noSubmodule: true,
        run: () => 0,
      });
      assert.equal(second.envExampleWritten, false);
      assert.match(fs.readFileSync(path.join(host, '.env.idt.example'), 'utf8'), /edited by host/);
      assert.equal(fs.existsSync(path.join(host, '.env.idt.local')), false);
      assert.deepEqual(second.gitignoreAdded, []);
    } finally {
      fs.rmSync(host, { recursive: true, force: true });
    }
  });
});
