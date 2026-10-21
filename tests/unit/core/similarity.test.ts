import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  levenshtein,
  similarity,
  scoreAcceptable,
  chooseReplacement,
} from '../../../src/idt/core/similarity.js';

describe('similarity', () => {
  it('Requirement 1: identity, empty string, and single char distance', () => {
    assert.equal(similarity('abcd', 'abcd'), 1);
    assert.equal(similarity('', ''), 1);
    assert.equal(similarity('a', ''), 0);
  });

  it('Requirement 2: similarity fraction and scoreAcceptable integer check', () => {
    assert.equal(similarity('abcd', 'abXd'), 0.75);
    assert.equal(scoreAcceptable(1, 4), true);
    assert.equal(scoreAcceptable(1, 3), false);
    assert.equal(scoreAcceptable(7, 25), true);
    assert.equal(scoreAcceptable(8, 25), false);
    assert.equal(scoreAcceptable(0, 0), true);
    assert.equal(scoreAcceptable(1, 0), false);
  });

  it('Requirement 3: chooseReplacement succeeds with single valid candidate', () => {
    assert.deepEqual(chooseReplacement('abcd', ['abXd']), {
      ok: true,
      name: 'abXd',
    });
  });

  it('Requirement 4: chooseReplacement rejects candidate with low similarity', () => {
    assert.deepEqual(chooseReplacement('abc', ['abX']), {
      ok: false,
      reason: 'low',
    });
  });

  it('Requirement 5: chooseReplacement selects top candidate when gap >= 0.05', () => {
    assert.deepEqual(
      chooseReplacement('aaaaaaaa', ['aaaaaaab', 'aaaaaabb']),
      {
        ok: true,
        name: 'aaaaaaab',
      },
    );
  });

  it('Requirement 6: chooseReplacement rejects when top two candidates gap < 0.05', () => {
    assert.deepEqual(
      chooseReplacement('aaaaaaaa', ['aaaaaaab', 'aaaaaaac']),
      {
        ok: false,
        reason: 'gap',
      },
    );
  });

  it('Requirement 7: chooseReplacement returns empty when candidate list is empty', () => {
    assert.deepEqual(chooseReplacement('abcd', []), {
      ok: false,
      reason: 'empty',
    });
  });

  it('deduplicates candidate names before computing ranking', () => {
    assert.deepEqual(
      chooseReplacement('aaaaaaaa', ['aaaaaaab', 'aaaaaaab', 'aaaaaabb']),
      {
        ok: true,
        name: 'aaaaaaab',
      },
    );
  });

  it('exact 0.05 gap is acceptable and allows replacement', () => {
    // Current length 20.
    // Candidate 1: dist 2 -> similarity = 1 - 2/20 = 0.90
    // Candidate 2: dist 3 -> similarity = 1 - 3/20 = 0.85
    // Diff is exactly 0.05
    const base = 'abcdefghijklmnopqrst';
    const cand1 = 'XXcdefghijklmnopqrst'; // dist 2 (0.90)
    const cand2 = 'XXXdefghijklmnopqrst'; // dist 3 (0.85)
    assert.equal(similarity(base, cand1), 0.9);
    assert.equal(similarity(base, cand2), 0.85);
    assert.deepEqual(chooseReplacement(base, [cand1, cand2]), {
      ok: true,
      name: cand1,
    });
  });
});
