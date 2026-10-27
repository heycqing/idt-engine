import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diffAriaSnapshots } from '../../../src/idt/core/dom-delta.js';

describe('diffAriaSnapshots', () => {
  it('returns role and name pairs that appear only after the action', () => {
    assert.deepEqual(
      diffAriaSnapshots('- button "提交"', '- button "提交"\n- dialog "提交成功"'),
      [{ role: 'dialog', name: '提交成功' }],
    );
  });

  it('does not return elements present in both snapshots', () => {
    assert.deepEqual(
      diffAriaSnapshots('- button "提交"', '- button "提交"'),
      [],
    );
  });

  it('does not return elements that disappeared after the action', () => {
    assert.deepEqual(
      diffAriaSnapshots('- alert "加载中"', '- button "完成"'),
      [{ role: 'button', name: '完成' }],
    );
  });

  it('returns a repeated role and name pair only once', () => {
    assert.deepEqual(
      diffAriaSnapshots('', '- alert "失败"\n- alert "失败"'),
      [{ role: 'alert', name: '失败' }],
    );
  });

  it('excludes elements with an empty accessible name', () => {
    assert.deepEqual(
      diffAriaSnapshots('', '- dialog ""\n- dialog "有名字"'),
      [{ role: 'dialog', name: '有名字' }],
    );
  });

  it('treats every named after element as appeared when before is empty', () => {
    assert.deepEqual(
      diffAriaSnapshots('', '- heading "标题"\n- button "确认"'),
      [
        { role: 'heading', name: '标题' },
        { role: 'button', name: '确认' },
      ],
    );
  });

  it('preserves the appearance order from the after snapshot', () => {
    assert.deepEqual(
      diffAriaSnapshots('', '- button "第三"\n- dialog "第一"\n- heading "第二"'),
      [
        { role: 'button', name: '第三' },
        { role: 'dialog', name: '第一' },
        { role: 'heading', name: '第二' },
      ],
    );
  });
});
