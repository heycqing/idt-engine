import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  diffAriaSnapshots,
  isUsableTextName,
} from '../../../src/idt/core/dom-delta.js';

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

  it('keeps a short text node as a candidate', () => {
    assert.deepEqual(diffAriaSnapshots('', '- text: 确认'), [
      { role: 'text', name: '确认' },
    ]);
  });

  it('filters a page-sized text node longer than 24 characters', () => {
    assert.deepEqual(
      diffAriaSnapshots('', '- text: 智能网格一键生成最优网格一键跟投自动下单查看详情以及更多说明'),
      [],
    );
  });

  it('filters a text node containing three whitespace-separated segments', () => {
    assert.deepEqual(diffAriaSnapshots('', '- text: 全部 范围 0.00~0.00'), []);
  });

  it('does not filter an equally long quoted accessible name for another role', () => {
    const name = '请输入第一创业证券客户号并继续完成后续身份验证步骤';
    assert.ok(name.length > 24);
    assert.deepEqual(diffAriaSnapshots('', `- textbox "${name}"`), [
      { role: 'textbox', name },
    ]);
  });
});

describe('isUsableTextName', () => {
  it('accepts 24 characters and rejects 25 characters', () => {
    assert.equal(isUsableTextName('一'.repeat(24)), true);
    assert.equal(isUsableTextName('一'.repeat(25)), false);
  });

  it('accepts two whitespace-separated segments and rejects three', () => {
    assert.equal(isUsableTextName('第一段 第二段'), true);
    assert.equal(isUsableTextName('第一段 第二段 第三段'), false);
  });

  it('keeps representative short locator names', () => {
    for (const name of ['确认', '我知道了', '查看详情', '请输入第一创业证券客户号']) {
      assert.equal(isUsableTextName(name), true, name);
    }
  });
});
