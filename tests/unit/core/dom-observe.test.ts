import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  hitProbeScript,
  parseObserved,
  readHitScript,
} from '../../../src/idt/core/dom-observe.js';

const valid = {
  tag: 'div',
  role: null,
  ownText: '完成',
  alt: null,
  css: '#app > div.result',
  visible: true,
};

describe('parseObserved', () => {
  it('drops malformed entries individually and keeps valid entries', () => {
    assert.deepEqual(parseObserved([
      valid,
      { ...valid, css: 42 },
      { ...valid, visible: 'yes' },
      { ...valid, role: 7 },
      { ...valid, alt: undefined },
    ]), [valid]);
  });

  it('returns an empty array for a non-array input', () => {
    assert.deepEqual(parseObserved({ items: [valid] }), []);
    assert.deepEqual(parseObserved(null), []);
  });

  it('redacts secrets in ownText and alt without changing other fields', () => {
    assert.deepEqual(parseObserved([
      { ...valid, ownText: 'Bearer top-secret', alt: 'sk-1234567890' },
    ]), [{
      ...valid,
      ownText: 'Bearer [REDACTED]',
      alt: '[REDACTED]',
    }]);
  });
});

describe('hit probe scripts', () => {
  it('installs a capturing click listener', () => {
    assert.match(hitProbeScript(), /addEventListener\([\s\S]*['"]click['"][\s\S]*true\s*\)/);
  });

  it('never prevents default behavior or stops propagation', () => {
    const source = hitProbeScript();
    assert.doesNotMatch(source, /preventDefault/);
    assert.doesNotMatch(source, /stopPropagation/);
  });

  it('guards repeated installation with an idempotency flag', () => {
    const source = hitProbeScript();
    assert.match(source, /__idt_hit_installed/);
    assert.match(source, /if\s*\([^)]*__idt_hit_installed[^)]*\)/);
  });

  it('clears the recorded hit after reading it', () => {
    const source = readHitScript();
    assert.match(source, /__idt_hit\s*=\s*null/);
  });
});
