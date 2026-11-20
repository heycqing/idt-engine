import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { partitionVerifyFindings } from '../../../src/idt/core/verify-exceptions.js';
import type { VerifyFinding } from '../../../src/idt/core/verify.js';

const exception = {
  project: 'kaiyuan',
  flowId: 'flow_8e321313ee',
  code: 'weak-assertion' as const,
  reason: 'M3 negative control',
};

const finding = (overrides: Partial<VerifyFinding> = {}): VerifyFinding => ({
  level: 'warning',
  code: 'weak-assertion',
  flowId: 'flow_8e321313ee',
  message: 'weak assertion',
  ...overrides,
});

describe('partitionVerifyFindings', () => {
  it('exempts only the exact project, flow, and code tuple', () => {
    const result = partitionVerifyFindings(
      'kaiyuan',
      [finding()],
      [exception],
    );

    assert.equal(result.exemptedWarnings.length, 1);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.errors.length, 0);
  });

  it('preserves warnings for another project or flow', () => {
    const findings = [
      finding(),
      finding({ flowId: 'flow_aaaaaaaaaa' }),
    ];
    const result = partitionVerifyFindings('other', findings, [exception]);

    assert.deepEqual(result.warnings, findings);
    assert.equal(result.exemptedWarnings.length, 0);
  });

  it('does not exempt a different flow or finding code in the same project', () => {
    const findings = [
      finding({ flowId: 'flow_aaaaaaaaaa' }),
      finding({ code: 'stale-topology' }),
    ];
    const result = partitionVerifyFindings('kaiyuan', findings, [exception]);

    assert.deepEqual(result.warnings, findings);
    assert.equal(result.exemptedWarnings.length, 0);
  });

  it('leaves inputs intact and retains finding and exception provenance', () => {
    const warning = Object.freeze(finding());
    const findings = [warning];
    const exceptions = [Object.freeze({ ...exception })];
    const result = partitionVerifyFindings('kaiyuan', findings, exceptions);

    assert.deepEqual(findings, [warning]);
    assert.deepEqual(exceptions, [exception]);
    assert.equal(result.exemptedWarnings[0].finding, warning);
    assert.equal(result.exemptedWarnings[0].exception, exceptions[0]);
  });

  it('never exempts errors and preserves unmatched warning order', () => {
    const first = finding({ flowId: 'flow_aaaaaaaaaa' });
    const error = finding({ level: 'error' });
    const last = finding({ flowId: 'flow_bbbbbbbbbb' });
    const result = partitionVerifyFindings(
      'kaiyuan',
      [first, error, last],
      [exception],
    );

    assert.deepEqual(result.errors, [error]);
    assert.deepEqual(result.warnings, [first, last]);
    assert.equal(result.exemptedWarnings.length, 0);
  });
});
