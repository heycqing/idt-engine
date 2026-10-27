import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DomDeltaSchema } from '../../../src/idt/core/ir-schema.js';

describe('DomDeltaSchema', () => {
  it('accepts the role/name and selector shapes', () => {
    assert.equal(DomDeltaSchema.safeParse({
      appearedRole: 'dialog',
      appearedName: '完成',
    }).success, true);
    assert.equal(DomDeltaSchema.safeParse({
      appearedSelector: '#app > div.result',
      appearedText: '完成',
    }).success, true);
  });

  it('rejects an object mixing fields from both shapes', () => {
    assert.equal(DomDeltaSchema.safeParse({
      appearedRole: 'dialog',
      appearedName: '完成',
      appearedSelector: '#app > div.result',
    }).success, false);
  });
});
