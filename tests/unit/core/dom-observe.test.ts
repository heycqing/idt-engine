import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import {
  actionGuardScript,
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

describe('action guard script', () => {
  function install(allowedActions = [{ route: '/start', role: 'text', name: '查看详情' }]) {
    const listeners = new Map<string, (event: any) => void>();
    class Element {
      constructor(readonly label: string) {}
      closest() { return this; }
      getAttribute(name: string) { return name === 'aria-label' ? this.label : null; }
      get value() { return ''; }
      get innerText() { return this.label; }
    }
    const window: Record<string, unknown> = {};
    const document = {
      addEventListener(type: string, handler: (event: any) => void) { listeners.set(type, handler); },
    };
    const location = { pathname: '/start', hash: '' };
    runInNewContext(actionGuardScript(allowedActions, { mode: 'history', base: '/' }), { window, document, Element, location });
    return { listeners, window, Element };
  }

  it('blocks dangerous controls before page handlers run', () => {
    const { listeners, window, Element } = install();
    let prevented = false;
    let stopped = false;
    listeners.get('click')?.({
      target: new Element('确认买入'),
      preventDefault() { prevented = true; },
      stopImmediatePropagation() { stopped = true; },
    });

    assert.equal(prevented, true);
    assert.equal(stopped, true);
    assert.equal(window.__idt_blocked_action, true);
  });

  it('does not block safe navigation controls', () => {
    const { listeners, window, Element } = install();
    let prevented = false;
    listeners.get('click')?.({
      target: new Element('查看详情'),
      preventDefault() { prevented = true; },
      stopImmediatePropagation() {},
    });

    assert.equal(prevented, false);
    assert.equal(window.__idt_blocked_action, undefined);
  });

  it('blocks a safe-looking but unapproved custom control', () => {
    const { listeners, window, Element } = install();
    let prevented = false;
    listeners.get('click')?.({
      target: new Element('继续'),
      preventDefault() { prevented = true; },
      stopImmediatePropagation() {},
    });

    assert.equal(prevented, true);
    assert.equal(window.__idt_blocked_action, true);
  });

  it('blocks unlabeled controls because their intent cannot be checked', () => {
    const { listeners, window, Element } = install();
    const target = new Element('');
    let prevented = false;
    listeners.get('click')?.({
      target,
      preventDefault() { prevented = true; },
      stopImmediatePropagation() {},
    });

    assert.equal(prevented, true);
    assert.equal(window.__idt_blocked_action, true);
  });

  it('still blocks dangerous labels even if a caller adds them to the allowlist', () => {
    const listeners = new Map<string, (event: any) => void>();
    class Element {
      constructor(readonly label: string) {}
      closest() { return this; }
      getAttribute(name: string) { return name === 'aria-label' ? this.label : null; }
      get value() { return ''; }
      get innerText() { return this.label; }
    }
    const window: Record<string, unknown> = {};
    const document = { addEventListener(type: string, handler: (event: any) => void) { listeners.set(type, handler); } };
    const location = { pathname: '/start', hash: '' };
    runInNewContext(actionGuardScript([
      { route: '/start', role: 'text', name: '确定' },
    ], { mode: 'history', base: '/' }), { window, document, Element, location });
    let prevented = false;
    listeners.get('click')?.({
      target: new Element('确定'),
      preventDefault() { prevented = true; },
      stopImmediatePropagation() {},
    });
    assert.equal(prevented, true);
  });

  it('blocks keyboard activation of unlabeled controls', () => {
    const { listeners, window, Element } = install();
    let prevented = false;
    listeners.get('keydown')?.({
      key: 'Enter',
      target: new Element(''),
      preventDefault() { prevented = true; },
      stopImmediatePropagation() {},
    });

    assert.equal(prevented, true);
    assert.equal(window.__idt_blocked_action, true);
  });
});
