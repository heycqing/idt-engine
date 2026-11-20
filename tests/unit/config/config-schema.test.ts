import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IdtConfigSchema } from '../../../src/idt/schemas/config.schema.js';

const base = { pageGlobs: ['src/pages/**/*.tsx'] };
const exception = {
  project: 'kaiyuan',
  flowId: 'flow_8e321313ee',
  code: 'weak-assertion',
  reason: 'M3 negative control',
};

describe('verify warning exceptions config', () => {
  it('accepts an exact weak-assertion exception', () => {
    const parsed = IdtConfigSchema.parse({
      ...base,
      verifyWarningExceptions: [{
        project: 'kaiyuan',
        flowId: 'flow_8e321313ee',
        code: 'weak-assertion',
        reason: 'M3 negative control',
      }],
    });

    assert.equal(parsed.verifyWarningExceptions.length, 1);
  });

  it('defaults to no exceptions', () => {
    assert.deepEqual(IdtConfigSchema.parse(base).verifyWarningExceptions, []);
  });

  for (const [name, overrides] of [
    ['empty reason', { reason: '' }],
    ['unsupported finding code', { code: 'stale-topology' }],
    ['empty project', { project: '' }],
    ['wildcard flow', { flowId: '*' }],
    ['extra matching fields', { pattern: '*' }],
  ] as const) {
    it(`rejects ${name}`, () => {
      const parsed = IdtConfigSchema.safeParse({
        ...base,
        verifyWarningExceptions: [{ ...exception, ...overrides }],
      });
      assert.equal(parsed.success, false);
    });
  }
});
