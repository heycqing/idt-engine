import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectComponentElements,
  collectComponentTransitions,
  resolveImportSpecifier,
} from '../../../src/idt/extract/component-nav.js';

function temp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'idt-comp-nav-'));
}

function write(root: string, rel: string, content: string): string {
  const full = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

describe('component navigation', () => {
  it('resolves @ alias, relative paths and index files', () => {
    const root = temp();
    try {
      const page = write(root, 'src/views/home/index.vue', '<template />');
      write(root, 'src/components/Nav.vue', '<template />');
      write(root, 'src/views/home/components/Card/index.vue', '<template />');
      write(root, 'src/utils/go.js', 'export default 1');

      assert.equal(
        resolveImportSpecifier('@/components/Nav.vue', page, root),
        path.join(root, 'src', 'components', 'Nav.vue'),
      );
      assert.equal(
        resolveImportSpecifier('./components/Card', page, root),
        path.join(root, 'src', 'views', 'home', 'components', 'Card', 'index.vue'),
      );
      assert.equal(
        resolveImportSpecifier('@/utils/go', page, root),
        path.join(root, 'src', 'utils', 'go.js'),
      );
      assert.equal(resolveImportSpecifier('vue', page, root), null, '第三方包不解析');
      assert.equal(resolveImportSpecifier('@/nope', page, root), null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('attributes a direct child component navigation to the page', () => {
    const root = temp();
    try {
      const page = write(
        root,
        'src/views/home/index.vue',
        `<template><Card /></template>
         <script>
         import Card from './components/Card.vue';
         export default { components: { Card } };
         </script>`,
      );
      write(
        root,
        'src/views/home/components/Card.vue',
        `<template><div @click="goDetail">查看明细</div></template>
         <script>
         export default {
           methods: {
             goDetail() { this.$router.push('/detail'); },
           },
         };
         </script>`,
      );

      const found = collectComponentTransitions(root, page, new Set(), 1);
      assert.equal(found.length, 1);
      assert.equal(found[0].targetRoute, '/detail');
      assert.equal(found[0].triggerType, 'CLICK');
      assert.equal(found[0].triggerElementText, '查看明细', '触发文本要取自组件自己的模板');
      assert.ok(found[0].codeSlice.includes('goDetail'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads { path: literal } as well as bare strings', () => {
    const root = temp();
    try {
      const page = write(root, 'src/views/a/index.vue',
        `<script>import C from './C.vue';</script>`);
      write(root, 'src/views/a/C.vue',
        `<script>export default { methods: {
           go() { this.$router.replace({ path: '/x', query: { a: 1 } }); },
         } };</script>`);

      const found = collectComponentTransitions(root, page, new Set(), 1);
      assert.deepEqual(found.map((t) => t.targetRoute), ['/x']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('stops at the configured depth and never walks into another page', () => {
    const root = temp();
    try {
      const page = write(root, 'src/views/a/index.vue', `<script>import C from './C.vue';</script>`);
      write(root, 'src/views/a/C.vue',
        `<script>import D from './D.vue';
         export default { methods: { go() { this.$router.push('/from-c'); } } };</script>`);
      write(root, 'src/views/a/D.vue',
        `<script>export default { methods: { go() { this.$router.push('/from-d'); } } };</script>`);
      const otherPage = write(root, 'src/views/b/index.vue',
        `<script>export default { methods: { go() { this.$router.push('/from-other-page'); } } };</script>`);

      const pages = new Set([otherPage]);
      const d1 = collectComponentTransitions(root, page, pages, 1);
      assert.deepEqual(d1.map((t) => t.targetRoute), ['/from-c'], '深度 1 不该走到 D');

      const d2 = collectComponentTransitions(root, page, pages, 2);
      assert.deepEqual(d2.map((t) => t.targetRoute).sort(), ['/from-c', '/from-d']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips other page files even at depth 1', () => {
    const root = temp();
    try {
      const page = write(root, 'src/views/a/index.vue',
        `<script>import Other from '../b/index.vue';</script>`);
      const other = write(root, 'src/views/b/index.vue',
        `<script>export default { methods: { go() { this.$router.push('/b-target'); } } };</script>`);

      const found = collectComponentTransitions(root, page, new Set([other]), 1);
      assert.deepEqual(found, [], '另一个页面的跳转不该算到本页头上');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores non-literal targets and history navigation', () => {
    const root = temp();
    try {
      const page = write(root, 'src/views/a/index.vue', `<script>import C from './C.vue';</script>`);
      write(root, 'src/views/a/C.vue',
        `<script>export default { methods: {
           a() { this.$router.push(this.target); },
           b() { this.$router.push({ path: key }); },
           c() { this.$router.go(-1); },
           d() { this.$router.back(); },
         } };</script>`);

      assert.deepEqual(collectComponentTransitions(root, page, new Set(), 1), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('deduplicates repeated targets within one page', () => {
    const root = temp();
    try {
      const page = write(root, 'src/views/a/index.vue',
        `<script>import C from './C.vue'; import D from './D.vue';</script>`);
      write(root, 'src/views/a/C.vue',
        `<script>export default { methods: { go() { this.$router.push('/same'); } } };</script>`);
      write(root, 'src/views/a/D.vue',
        `<script>export default { methods: { go() { this.$router.push('/same'); } } };</script>`);

      const found = collectComponentTransitions(root, page, new Set(), 1);
      assert.equal(found.length, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('collects elements from child components too', () => {
    const root = temp();
    try {
      const page = write(
        root,
        'src/views/home/index.vue',
        `<template><Nav /></template>
         <script>import Nav from './components/Nav.vue';</script>`,
      );
      write(
        root,
        'src/views/home/components/Nav.vue',
        `<template>
           <div @click="go">账户管理</div>
           <button>保存</button>
         </template>
         <script>export default { methods: { go() {} } };</script>`,
      );

      const found = collectComponentElements(root, page, new Set(), 1);
      assert.deepEqual(found, [
        { role: 'text', name: '账户管理' },
        { role: 'button', name: '保存' },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not take elements from another page', () => {
    const root = temp();
    try {
      const page = write(root, 'src/views/a/index.vue',
        `<script>import B from '../b/index.vue';</script>`);
      const other = write(root, 'src/views/b/index.vue',
        '<template><button>别的页面的按钮</button></template>');

      assert.deepEqual(collectComponentElements(root, page, new Set([other]), 1), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
