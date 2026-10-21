import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractVueSfc, listVueFiles, scanVueTemplate, stripVueFromGlob } from '../../../src/idt/extract/vue-sfc.js';

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
  it('maps tags to aria roles and drops tags outside the table', () => {
    const scan = scanVueTemplate(`
      <div>
        <button>提交</button>
        <van-button>撤单</van-button>
        <div role="button">自定义按钮</div>
        <span @click="onPick">可点文字</span>
        <router-link to="/a">去 A</router-link>
        <a href="/b">去 B</a>
        <input type="text" placeholder="股票代码" />
        <textarea placeholder="备注"></textarea>
        <van-field label="委托数量" />
        <input type="checkbox" aria-label="全选" />
        <van-switch aria-label="自动续期" />
        <input type="radio" aria-label="限价" />
        <select aria-label="账户"></select>
        <van-picker aria-label="到期日" />
        <h2>持仓明细</h2>
        <van-tab title="融资"></van-tab>
        <p>这是一段说明文字</p>
        <section>区块</section>
      </div>
    `);
    const pairs = scan.elements.map((el) => `${el.role}:${el.name ?? ''}`);
    assert.deepEqual(pairs, [
      'button:提交',
      'button:撤单',
      'button:自定义按钮',
      'button:可点文字',
      'link:去 A',
      'link:去 B',
      'textbox:股票代码',
      'textbox:备注',
      'textbox:委托数量',
      'checkbox:全选',
      'checkbox:自动续期',
      'radio:限价',
      'combobox:账户',
      'combobox:到期日',
      'heading:持仓明细',
      'tab:融资',
    ]);
  });

  it('resolves the accessible name by source priority', () => {
    const scan = scanVueTemplate(`
      <div>
        <button aria-label="关闭弹窗" title="标题属性">文字内容</button>
        <van-field label="标签优先" placeholder="占位兜底" />
        <input type="text" placeholder="只有占位" />
        <button title="只有标题"></button>
        <button>只有文字</button>
      </div>
    `);
    assert.deepEqual(
      scan.elements.map((el) => el.name),
      ['关闭弹窗', '标签优先', '只有占位', '只有标题', '只有文字'],
    );
  });

  it('marks interpolated and bound names as dynamic without inventing a name', () => {
    const scan = scanVueTemplate(`
      <div>
        <button>{{ submitLabel }}</button>
        <van-button :aria-label="closeLabel">x</van-button>
        <van-field :placeholder="hint" />
        <button>确定</button>
      </div>
    `);
    assert.deepEqual(scan.elements, [
      { role: 'button', dynamic: true, tag: 'button' },
      { role: 'button', dynamic: true, tag: 'van-button' },
      { role: 'textbox', dynamic: true, tag: 'van-field' },
      { role: 'button', name: '确定' },
    ]);
  });

  it('deduplicates elements that share both role and name', () => {
    const scan = scanVueTemplate(`
      <div>
        <button>买入</button>
        <van-button>买入</van-button>
        <a href="/x">买入</a>
      </div>
    `);
    assert.deepEqual(scan.elements, [
      { role: 'button', name: '买入' },
      { role: 'link', name: '买入' },
    ]);
  });
});
