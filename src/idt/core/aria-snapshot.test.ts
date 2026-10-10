import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAriaSnapshot } from './aria-snapshot.js';

describe('aria-snapshot', () => {
  it('parses simple role and name with leading spaces', () => {
    const snapshot = '  - button "确认去结账订单"';
    const parsed = parseAriaSnapshot(snapshot);
    assert.deepEqual(parsed, [{ role: 'button', name: '确认去结账订单' }]);
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
});
