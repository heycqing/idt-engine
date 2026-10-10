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
  renderPlaywrightConfig,
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
      assert.ok(found.pageGlobs.includes('src/pages/**/*.{tsx,jsx,ts,js}'));
      assert.ok(found.pageGlobs.includes('apps/web/src/views/**/*.{tsx,jsx,ts,js}'));
    } finally {
      fs.rmSync(host, { recursive: true, force: true });
    }
  });

  it('builds a posix path from the host to the engine', () => {
    const rel = toPosixRelative('D:\\host', 'D:\\host\\idt-engine');
    assert.equal(rel.includes('\\'), false);
    assert.match(desiredScripts('./idt-engine')['idt:sync'], /tsx \.\/idt-engine\/scripts\/idt\/cli\.ts sync/);
  });

  it('appends gitignore entries once', () => {
    const first = mergeGitignore('node_modules/\n');
    assert.deepEqual(first.added, ['.idt/', 'test-results/', 'playwright-report/', 'blob-report/']);
    const second = mergeGitignore(first.text);
    assert.deepEqual(second.added, []);
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
      assert.match(pkg.scripts['idt:sync'], /scripts\/idt\/cli\.ts sync/);
      assert.equal(pkg.scripts['test:e2e'], 'playwright test --config=playwright.idt.config.ts');
      const playwright = fs.readFileSync(path.join(host, 'playwright.idt.config.ts'), 'utf8');
      assert.match(playwright, /pnpm dev/);
      assert.equal(playwright.includes('retries: 0'), true);
      assert.match(fs.readFileSync(path.join(host, '.gitignore'), 'utf8'), /\.idt\//);
    } finally {
      fs.rmSync(host, { recursive: true, force: true });
    }
  });

  it('keeps an existing test:e2e script and uses pnpm start when dev is absent', () => {
    assert.match(renderPlaywrightConfig('pnpm start'), /'pnpm start'/);
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
      assert.equal(pkg.scripts['test:idt:e2e'], 'playwright test --config=playwright.idt.config.ts');
      assert.match(fs.readFileSync(path.join(host, 'playwright.idt.config.ts'), 'utf8'), /pnpm start/);
    } finally {
      fs.rmSync(host, { recursive: true, force: true });
    }
  });
});
