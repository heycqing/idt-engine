import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ROUTER_URL_OPTIONS,
  routerUrlOptions,
  toBrowserUrl,
  toGuardPattern,
} from '../../../src/idt/core/route-url.js';

const history = { mode: 'history' as const };
const hash = { mode: 'hash' as const };

describe('route url', () => {
  it('leaves history routes untouched', () => {
    assert.equal(toBrowserUrl('/credit/amount', history), '/credit/amount');
    assert.equal(toBrowserUrl('/', history), '/');
    // 不传选项时必须等同 history，这是既有宿主的回归基线
    assert.equal(toBrowserUrl('/credit/amount'), '/credit/amount');
    assert.deepEqual(DEFAULT_ROUTER_URL_OPTIONS, { mode: 'history', base: '/' });
  });

  it('inserts the hash for hash mode', () => {
    assert.equal(toBrowserUrl('/credit/amount', hash), '/#/credit/amount');
    assert.equal(toBrowserUrl('/', hash), '/#/');
  });

  it('puts the base before the hash and tolerates a missing trailing slash', () => {
    assert.equal(
      toBrowserUrl('/credit/amount', { mode: 'hash', base: '/trade/' }),
      '/trade/#/credit/amount',
    );
    assert.equal(
      toBrowserUrl('/credit/amount', { mode: 'hash', base: '/trade' }),
      '/trade/#/credit/amount',
    );
    assert.equal(
      toBrowserUrl('/credit/amount', { mode: 'history', base: '/trade/' }),
      '/trade/credit/amount',
    );
  });

  it('keeps the history guard pattern byte-identical to the previous behaviour', () => {
    assert.equal(toGuardPattern('/checkout$', history), '/checkout$');
    assert.equal(toGuardPattern('/checkout/success$', history), '/checkout/success$');
    assert.equal(toGuardPattern('/checkout$'), '/checkout$');
  });

  it('moves the hash guard anchor onto # without touching the regex', () => {
    assert.equal(toGuardPattern('/credit/amount$', hash), '#/credit/amount$');
    assert.equal(toGuardPattern('/credit/amount', hash), '#/credit/amount');
    // 已经带 # 或不是以 / 开头的片段原样返回，不重复加前缀
    assert.equal(toGuardPattern('#/credit/amount$', hash), '#/credit/amount$');
    assert.equal(toGuardPattern('checkout', hash), 'checkout');
  });

  it('leaves the base out of the guard pattern', () => {
    assert.equal(
      toGuardPattern('/credit/amount$', { mode: 'hash', base: '/trade/' }),
      '#/credit/amount$',
    );
  });

  it('reads the options off a topology, defaulting to history', () => {
    assert.deepEqual(routerUrlOptions({}), DEFAULT_ROUTER_URL_OPTIONS);
    assert.deepEqual(routerUrlOptions({ router: { mode: 'hash', base: '/trade/' } }), {
      mode: 'hash',
      base: '/trade/',
    });
  });
});
