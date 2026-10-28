import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeInputsDigest } from '../../../src/idt/extract/inputs-digest.js';

function createTempDir(prefix = 'idt-inputs-digest-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

function writeFile(dir: string, relPath: string, content: string | Buffer): void {
  const fullPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

const config = {
  pageGlobs: ['src/pages/**/*.{tsx,jsx,vue}'],
  routerGlobs: ['src/router/**/*.{js,ts}'],
  localeFiles: ['src/locales/zh-CN.json'],
};

function seedProject(root: string): void {
  writeFile(root, 'src/pages/home.tsx', 'export default function Home() { return null; }\n');
  writeFile(root, 'src/pages/about.tsx', 'export default function About() { return null; }\n');
  writeFile(root, 'src/router/index.ts', 'export const routes = [];\n');
  writeFile(root, 'src/locales/zh-CN.json', '{"hello":"你好"}\n');
}

describe('computeInputsDigest', () => {
  it('returns the same 64-char hex digest for the same files', () => {
    const root = createTempDir();
    try {
      seedProject(root);
      const a = computeInputsDigest(root, config);
      const b = computeInputsDigest(root, config);
      assert.equal(a, b);
      assert.match(a, /^[0-9a-f]{64}$/);
    } finally {
      removeTempDir(root);
    }
  });

  it('changes when a matched file’s content changes', () => {
    const root = createTempDir();
    try {
      seedProject(root);
      const before = computeInputsDigest(root, config);
      writeFile(root, 'src/pages/home.tsx', 'export default function Home() { return 1; }\n');
      const after = computeInputsDigest(root, config);
      assert.notEqual(after, before);
    } finally {
      removeTempDir(root);
    }
  });

  it('changes when a new matched file is added', () => {
    const root = createTempDir();
    try {
      seedProject(root);
      const before = computeInputsDigest(root, config);
      writeFile(root, 'src/pages/settings.tsx', 'export default function Settings() { return null; }\n');
      const after = computeInputsDigest(root, config);
      assert.notEqual(after, before);
    } finally {
      removeTempDir(root);
    }
  });

  it('changes when a matched file is deleted', () => {
    const root = createTempDir();
    try {
      seedProject(root);
      const before = computeInputsDigest(root, config);
      fs.unlinkSync(path.join(root, 'src/pages/about.tsx'));
      const after = computeInputsDigest(root, config);
      assert.notEqual(after, before);
    } finally {
      removeTempDir(root);
    }
  });

  it('changes when a matched file is renamed with identical content', () => {
    const root = createTempDir();
    try {
      seedProject(root);
      const before = computeInputsDigest(root, config);
      fs.renameSync(
        path.join(root, 'src/pages/about.tsx'),
        path.join(root, 'src/pages/about-us.tsx'),
      );
      const after = computeInputsDigest(root, config);
      assert.notEqual(after, before);
    } finally {
      removeTempDir(root);
    }
  });

  it('is independent of filesystem creation order', () => {
    const rootA = createTempDir('idt-digest-a-');
    const rootB = createTempDir('idt-digest-b-');
    try {
      writeFile(rootA, 'src/pages/a.tsx', 'A\n');
      writeFile(rootA, 'src/pages/b.tsx', 'B\n');
      writeFile(rootA, 'src/router/index.ts', 'R\n');
      writeFile(rootA, 'src/locales/zh-CN.json', '{}\n');

      writeFile(rootB, 'src/locales/zh-CN.json', '{}\n');
      writeFile(rootB, 'src/router/index.ts', 'R\n');
      writeFile(rootB, 'src/pages/b.tsx', 'B\n');
      writeFile(rootB, 'src/pages/a.tsx', 'A\n');

      assert.equal(computeInputsDigest(rootA, config), computeInputsDigest(rootB, config));
    } finally {
      removeTempDir(rootA);
      removeTempDir(rootB);
    }
  });

  it('ignores files outside every glob', () => {
    const root = createTempDir();
    try {
      seedProject(root);
      const before = computeInputsDigest(root, config);
      writeFile(root, 'README.md', '# changed\n');
      writeFile(root, 'src/other/x.ts', 'export const x = 1;\n');
      const after = computeInputsDigest(root, config);
      assert.equal(after, before);
    } finally {
      removeTempDir(root);
    }
  });

  it('treats CRLF and LF as different byte content', () => {
    const rootLf = createTempDir('idt-digest-lf-');
    const rootCrlf = createTempDir('idt-digest-crlf-');
    try {
      writeFile(rootLf, 'src/pages/home.tsx', Buffer.from('a\nb'));
      writeFile(rootLf, 'src/router/index.ts', 'R\n');
      writeFile(rootLf, 'src/locales/zh-CN.json', '{}\n');

      writeFile(rootCrlf, 'src/pages/home.tsx', Buffer.from('a\r\nb'));
      writeFile(rootCrlf, 'src/router/index.ts', 'R\n');
      writeFile(rootCrlf, 'src/locales/zh-CN.json', '{}\n');

      assert.notEqual(
        computeInputsDigest(rootLf, config),
        computeInputsDigest(rootCrlf, config),
      );
    } finally {
      removeTempDir(rootLf);
      removeTempDir(rootCrlf);
    }
  });

  it('does not throw when a glob or locale path misses', () => {
    const root = createTempDir();
    try {
      writeFile(root, 'src/pages/home.tsx', 'export default function Home() { return null; }\n');
      assert.doesNotThrow(() =>
        computeInputsDigest(root, {
          pageGlobs: ['src/pages/**/*.tsx', 'src/missing/**/*.tsx'],
          routerGlobs: ['src/router/**/*.ts'],
          localeFiles: ['src/locales/zh-CN.json', 'src/locales/missing.json'],
        }),
      );
      const digest = computeInputsDigest(root, {
        pageGlobs: ['src/pages/**/*.tsx', 'src/missing/**/*.tsx'],
        routerGlobs: ['src/router/**/*.ts'],
        localeFiles: ['src/locales/zh-CN.json', 'src/locales/missing.json'],
      });
      assert.match(digest, /^[0-9a-f]{64}$/);
    } finally {
      removeTempDir(root);
    }
  });
});
