import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from '@playwright/test';
import { observeScript, parseObserved } from '../../src/idt/core/dom-observe.js';

let browser: Browser;
let page: Page;

before(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});

after(async () => {
  await browser.close();
});

async function observe(html: string) {
  await page.setContent(html);
  return parseObserved(await page.evaluate(observeScript()));
}

describe('DOM observation in Chromium', () => {
  it('collects three direct text owners without collecting their parent', async () => {
    const result = await observe(`
      <main id="app"><section class="panel">
        <div class="title">智能网格</div>
        <div class="tips">一键生成最优网格，一键跟投，自动下单</div>
        <div class="details">查看详情</div>
      </section></main>
    `);
    assert.deepEqual(result.map(({ ownText }) => ownText), [
      '智能网格',
      '一键生成最优网格，一键跟投，自动下单',
      '查看详情',
    ]);
    assert.equal(result.some(({ css }) => css.endsWith('section.panel')), false);
  });

  it('uses nth-of-type for same-tag siblings and every selector is unique', async () => {
    const result = await observe(`
      <main id="app"><div>甲</div><div>乙</div><div>丙</div></main>
    `);
    assert.equal(result.length, 3);
    assert.ok(result.every(({ css }) => css.includes(':nth-of-type(')));
    for (const { css } of result) {
      assert.equal(await page.locator(css).count(), 1, css);
    }
  });

  it('drops an element whose selector is still ambiguous after six levels', async () => {
    const branch = '<article><section><div><div><div><div><span>重复</span></div></div></div></section></article>';
    const result = await observe(`<main>${branch}${branch}</main>`);
    assert.equal(result.some(({ ownText }) => ownText === '重复'), false);
  });

  it('keeps zero-sized elements as invisible', async () => {
    const result = await observe('<div id="hidden" style="display:none">隐藏</div>');
    assert.deepEqual(result, [{
      tag: 'div', role: null, ownText: '隐藏', alt: null, css: '#hidden', visible: false,
    }]);
  });

  it('omits hash-like classes from selectors', async () => {
    const result = await observe(`
      <div id="root"><span class="label _3xK9f data-v-1a2b3c">稳定</span></div>
    `);
    assert.equal(result.length, 1);
    assert.match(result[0].css, /label/);
    assert.doesNotMatch(result[0].css, /_3xK9f|data-v-/);
  });

  it('collects img alt text without reading element values or data attributes', async () => {
    const result = await observe(`
      <main id="app"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" alt="活动图"></main>
    `);
    assert.equal(result.length, 1);
    assert.equal(result[0].tag, 'img');
    assert.equal(result[0].ownText, '');
    assert.equal(result[0].alt, '活动图');
  });
});
