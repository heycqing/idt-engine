import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractVueSfc, listVueFiles, scanVueTemplate, stripVueFromGlob } from './vue-sfc.js';

describe('vue sfc', () => {
  it('strips vue out of mixed globs and drops vue-only globs', () => {
    assert.equal(
      stripVueFromGlob('src/views/**/*.{tsx,jsx,ts,js,vue}'),
      'src/views/**/*.{tsx,jsx,ts,js}',
    );
    assert.equal(stripVueFromGlob('src/views/**/*.vue'), null);
    assert.equal(stripVueFromGlob('src/app/**/page.{tsx,jsx}'), 'src/app/**/page.{tsx,jsx}');
  });

  it('reads template and script, and ignores commented markup', () => {
    const source = `
      <template>
        <router-link to="/statement/history">历史成交</router-link>
        <!-- <router-link to="/subscribe/plan">计划</router-link> -->
      </template>
      <script>
      export default { methods: { goCart() {} } }
      </script>
    `;
    const sfc = extractVueSfc(source);
    assert.match(sfc.template, /历史成交/);
    assert.equal(sfc.template.includes('计划'), false);
    assert.match(sfc.script, /goCart/);
  });

  it('scans router-link, bound path, click handlers, and visible text', () => {
    const scan = scanVueTemplate(`
      <div class="history flex">
        <router-link to="/statement/history">历史成交</router-link>
        <router-link :to="{ path: '/subscribe/lucky' }">中签</router-link>
        <button @click.stop="goCart()">去结算</button>
        <span>{{ $t('trade.buy') }}</span>
      </div>
    `);
    assert.deepEqual(
      scan.links.map((link) => link.targetRoute),
      ['/statement/history', '/subscribe/lucky'],
    );
    assert.equal(scan.links[0].text, '历史成交');
    assert.equal(scan.links[1].text, '中签');
    assert.equal(scan.clicks.get('goCart'), '去结算');
    assert.deepEqual(scan.i18nKeys, ['trade.buy']);
    assert.equal(scan.texts.includes('history flex'), false);
    assert.equal(scan.texts.includes('历史成交'), true);
  });

  it('lists vue files that match the glob and skips node_modules', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idt-vue-'));
    try {
      const page = path.join(root, 'src', 'views', 'cart', 'index.vue');
      const skipped = path.join(root, 'node_modules', 'pkg', 'index.vue');
      fs.mkdirSync(path.dirname(page), { recursive: true });
      fs.mkdirSync(path.dirname(skipped), { recursive: true });
      fs.writeFileSync(page, '<template><div>购物车</div></template>');
      fs.writeFileSync(skipped, '<template><div>忽略</div></template>');
      const found = listVueFiles(root, ['src/views/**/*.{tsx,jsx,ts,js,vue}']);
      assert.deepEqual(found, ['src/views/cart/index.vue']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
