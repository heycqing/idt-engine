import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAriaSnapshot } from '../../../src/idt/core/aria-snapshot.js';

describe('aria-snapshot', () => {
  it('parses a quoted role and name with leading spaces', () => {
    const snapshot = '  - button "名字"';
    const parsed = parseAriaSnapshot(snapshot);
    assert.deepEqual(parsed, [{ role: 'button', name: '名字' }]);
  });

  it('ignores a state suffix after a quoted name', () => {
    assert.deepEqual(parseAriaSnapshot('- button "名字" [disabled]'), [
      { role: 'button', name: '名字' },
    ]);
  });

  it('parses an unquoted text node after the colon', () => {
    assert.deepEqual(parseAriaSnapshot('- text: 内容'), [
      { role: 'text', name: '内容' },
    ]);
  });

  it('trims multiple spaces after a text-node colon', () => {
    assert.deepEqual(parseAriaSnapshot('- text:  有多个空格'), [
      { role: 'text', name: '有多个空格' },
    ]);
  });

  it('keeps an empty unquoted text-node name', () => {
    assert.deepEqual(parseAriaSnapshot('- text:'), [
      { role: 'text', name: '' },
    ]);
  });

  it('parses a bare role with an empty name', () => {
    assert.deepEqual(parseAriaSnapshot('- iframe'), [
      { role: 'iframe', name: '' },
    ]);
  });

  it('supports escaped double quotes and backslashes in name', () => {
    const snapshot = '- button "他说\\"好\\""\n- textbox "path\\\\to\\\\dir"';
    const parsed = parseAriaSnapshot(snapshot);
    assert.deepEqual(parsed, [
      { role: 'button', name: '他说"好"' },
      { role: 'textbox', name: 'path\\to\\dir' },
    ]);
  });

  it('ignores lines without quoted names like - navigation:', () => {
    const snapshot = `
- navigation:
  - list:
    - listitem:
      - button "确认去结账订单"
    `;
    const parsed = parseAriaSnapshot(snapshot);
    assert.deepEqual(parsed, [{ role: 'button', name: '确认去结账订单' }]);
  });

  it('ignores trailing metadata such as [level=1] or [checked=true]', () => {
    const snapshot = `
- heading "订单详情" [level=1]
- checkbox "同意协议" [checked=true]
    `;
    const parsed = parseAriaSnapshot(snapshot);
    assert.deepEqual(parsed, [
      { role: 'heading', name: '订单详情' },
      { role: 'checkbox', name: '同意协议' },
    ]);
  });

  it('parses real Playwright snapshots with unquoted text and bare iframe rows', () => {
    const intro = [
      '- text:  智能网格 一键生成最优网格，一键跟投，自动下单 查看详情 箭',
      '- iframe',
    ].join('\n');
    const allocation = [
      '- text: 信用额度分配 剩余可用额度 0.00 融资 总额度 0.00 当前融资 0.00 拟调整融资额度 ¥',
      '- spinbutton "请输入调整额度"',
      '- text: 全部 范围 0.00~0.00',
      '- button "融资分配" [disabled]',
    ].join('\n');

    assert.deepEqual(parseAriaSnapshot(intro), [
      {
        role: 'text',
        name: '智能网格 一键生成最优网格，一键跟投，自动下单 查看详情 箭',
      },
      { role: 'iframe', name: '' },
    ]);
    assert.deepEqual(parseAriaSnapshot(allocation), [
      {
        role: 'text',
        name: '信用额度分配 剩余可用额度 0.00 融资 总额度 0.00 当前融资 0.00 拟调整融资额度 ¥',
      },
      { role: 'spinbutton', name: '请输入调整额度' },
      { role: 'text', name: '全部 范围 0.00~0.00' },
      { role: 'button', name: '融资分配' },
    ]);
  });
});
