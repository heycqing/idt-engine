import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIntent, flowIdFromIntent } from './intent.js';

describe('intent and flowId', () => {
  it('Requirement 7: flowId derivation and normalization rules', () => {
    // 1. flowIdFromIntent('购物车') called twice is identical
    const id1 = flowIdFromIntent('购物车');
    const id2 = flowIdFromIntent('购物车');
    assert.equal(id1, id2);
    assert.match(id1, /^flow_[a-f0-9]{10}$/);

    // 2. flowIdFromIntent('AA') equals flowIdFromIntent('aa')
    assert.equal(flowIdFromIntent('AA'), flowIdFromIntent('aa'));

    // 3. flowIdFromIntent('a  b') equals flowIdFromIntent('a b')
    assert.equal(flowIdFromIntent('a  b'), flowIdFromIntent('a b'));

    // 4. Different Chinese intents have different flowIds
    assert.notEqual(flowIdFromIntent('购物车'), flowIdFromIntent('提交订单'));

    // Extra normalization checks
    assert.equal(normalizeIntent('  Hello \t World \n  '), 'hello world');
    assert.equal(normalizeIntent('测试  用例  A'), '测试 用例 a');
  });
});
