import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  IdtProjectError,
  resolveProjects,
  selectProject,
} from '../../../src/idt/config/projects.js';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'idt-projects-'));
}

function write(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

function mark(root: string, dir: string, idt: unknown, name = 'pkg'): void {
  write(root, `${dir}/package.json`, JSON.stringify({ name, idt }, null, 2));
}

describe('idt projects', () => {
  it('falls back to a single project when no marker exists', () => {
    const root = tempRoot();
    try {
      fs.mkdirSync(path.join(root, 'src', 'views'), { recursive: true });
      const projects = resolveProjects(root, {
        pageGlobs: ['src/views/**/*.vue'],
        routerGlobs: ['src/router/**/*.js'],
        localeFiles: ['locales/zh-CN.json'],
      });

      assert.equal(projects.length, 1);
      assert.equal(projects[0].root, root);
      assert.equal(projects[0].implicit, true);
      assert.deepEqual(projects[0].pageGlobs, ['src/views/**/*.vue']);
      assert.deepEqual(projects[0].routerGlobs, ['src/router/**/*.js']);
      assert.deepEqual(projects[0].localeFiles, ['locales/zh-CN.json']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('discovers one project per marked package under apps', () => {
    const root = tempRoot();
    try {
      mark(root, 'apps/caida', { project: 'caida' }, '@trade/caida');
      mark(root, 'apps/yuekai', { project: 'yuekai' }, '@trade/yuekai');
      write(root, 'apps/nomark/package.json', JSON.stringify({ name: '@trade/nomark' }));

      const projects = resolveProjects(root, { pageGlobs: ['x'], routerGlobs: [], localeFiles: [] });
      assert.deepEqual(projects.map((p) => p.name), ['caida', 'yuekai']);
      assert.equal(projects[0].root, path.join(root, 'apps', 'caida'));
      assert.equal(projects[0].implicit, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('defaults the project name to its directory name', () => {
    const root = tempRoot();
    try {
      mark(root, 'apps/xinda', {}, '@trade/xinda');
      const projects = resolveProjects(root, { pageGlobs: [], routerGlobs: [], localeFiles: [] });
      assert.deepEqual(projects.map((p) => p.name), ['xinda']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers globs written on the marker over detection', () => {
    const root = tempRoot();
    try {
      mark(root, 'apps/caida', {
        project: 'caida',
        pageGlobs: ['src/custom/**/*.vue'],
        routerGlobs: ['src/custom-router/**/*.js'],
        localeFiles: ['i18n/zh.json'],
      });
      fs.mkdirSync(path.join(root, 'apps', 'caida', 'src', 'views'), { recursive: true });

      const [project] = resolveProjects(root, { pageGlobs: [], routerGlobs: [], localeFiles: [] });
      assert.deepEqual(project.pageGlobs, ['src/custom/**/*.vue']);
      assert.deepEqual(project.routerGlobs, ['src/custom-router/**/*.js']);
      assert.deepEqual(project.localeFiles, ['i18n/zh.json']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects globs against the project root when the marker omits them', () => {
    const root = tempRoot();
    try {
      mark(root, 'apps/caida', { project: 'caida' });
      for (const dir of ['src/views', 'src/credit/views', 'src/router', 'src/credit/router']) {
        fs.mkdirSync(path.join(root, 'apps', 'caida', ...dir.split('/')), { recursive: true });
      }

      const [project] = resolveProjects(root, { pageGlobs: [], routerGlobs: [], localeFiles: [] });
      assert.deepEqual(project.pageGlobs, [
        'src/views/**/*.{tsx,jsx,ts,js,vue}',
        'src/credit/views/**/*.{tsx,jsx,ts,js,vue}',
      ]);
      assert.deepEqual(project.routerGlobs, [
        'src/router/**/*.{js,ts}',
        'src/credit/router/**/*.{js,ts}',
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('honours projectGlobs from the config', () => {
    const root = tempRoot();
    try {
      mark(root, 'apps/caida', { project: 'caida' });
      mark(root, 'vendor/legacy', { project: 'legacy' });

      const projects = resolveProjects(root, {
        pageGlobs: [],
        routerGlobs: [],
        localeFiles: [],
        projectGlobs: ['vendor/*'],
      });
      assert.deepEqual(projects.map((p) => p.name), ['legacy']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('selects by explicit name and reports the options when the name is unknown', () => {
    const root = tempRoot();
    try {
      mark(root, 'apps/caida', { project: 'caida' });
      mark(root, 'apps/yuekai', { project: 'yuekai' });
      const projects = resolveProjects(root, { pageGlobs: [], routerGlobs: [], localeFiles: [] });

      assert.equal(selectProject(projects, { name: 'yuekai', cwd: root }).name, 'yuekai');
      assert.throws(
        () => selectProject(projects, { name: 'nope', cwd: root }),
        (err: unknown) => {
          assert.ok(err instanceof IdtProjectError);
          assert.equal(err.exitCode, 2);
          assert.match(err.message, /caida/);
          assert.match(err.message, /yuekai/);
          return true;
        },
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('infers the project from the working directory', () => {
    const root = tempRoot();
    try {
      mark(root, 'apps/caida', { project: 'caida' });
      mark(root, 'apps/yuekai', { project: 'yuekai' });
      const projects = resolveProjects(root, { pageGlobs: [], routerGlobs: [], localeFiles: [] });

      const deep = path.join(root, 'apps', 'yuekai', 'src', 'views');
      assert.equal(selectProject(projects, { cwd: deep }).name, 'yuekai');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to guess when several projects exist and the cwd is outside all of them', () => {
    const root = tempRoot();
    try {
      mark(root, 'apps/caida', { project: 'caida' });
      mark(root, 'apps/yuekai', { project: 'yuekai' });
      const projects = resolveProjects(root, { pageGlobs: [], routerGlobs: [], localeFiles: [] });

      assert.throws(
        () => selectProject(projects, { cwd: root }),
        (err: unknown) => {
          assert.ok(err instanceof IdtProjectError);
          assert.equal(err.exitCode, 2);
          assert.match(err.message, /caida/);
          assert.match(err.message, /yuekai/);
          return true;
        },
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('selects the only project without a hint', () => {
    const root = tempRoot();
    try {
      mark(root, 'apps/caida', { project: 'caida' });
      const projects = resolveProjects(root, { pageGlobs: [], routerGlobs: [], localeFiles: [] });
      assert.equal(selectProject(projects, { cwd: root }).name, 'caida');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
