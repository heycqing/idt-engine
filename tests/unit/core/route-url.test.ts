import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ROUTER_URL_OPTIONS,
  fromBrowserUrl,
  routerUrlOptions,
  toBrowserUrl,
  toGuardPattern,
} from '../../../src/idt/core/route-url.js';

const history = { mode: 'history' as const };
const hash = { mode: 'hash' as const };

describe('route url', () => {
  it('anchors exact application-route patterns at the router base while allowing destination query and fragment tails', () => {
    for (const mode of ['hash', 'history'] as const) {
      for (const base of ['/', '/one/', '/another/']) {
        const pattern = new RegExp(toGuardPattern('^/next$', { mode, base }));
        const routePrefix = `https://fixture.test${base}${mode === 'hash' ? '#/' : ''}`;
        assert.equal(pattern.test(`${routePrefix}next`), true);
        assert.equal(pattern.test(`${routePrefix}next?id=1#section`), true);
        assert.equal(pattern.test(`${routePrefix}foo/next`), false);
        assert.equal(pattern.test(`${routePrefix}next-more`), false);
        assert.equal(pattern.test(`${routePrefix}next/child`), false);
      }
    }
  });

  it('groups alternation inside an exact application-route URL boundary', () => {
    const pattern = new RegExp(toGuardPattern('^/next|/done$', history));

    assert.equal(pattern.test('http://fixture.test/next'), true);
    assert.equal(pattern.test('http://fixture.test/done'), true);
    assert.equal(pattern.test('http://fixture.test/next-more'), false);
    assert.equal(pattern.test('http://fixture.test/foo/done'), false);
  });

  it('leaves history routes untouched', () => {
    assert.equal(toBrowserUrl('/credit/amount', history), '/credit/amount');
    assert.equal(toBrowserUrl('/', history), '/');
    // 不传选项时必须等同 history，这是既有宿主的回归基线
    assert.equal(toBrowserUrl('/credit/amount'), '/credit/amount');
    assert.deepEqual(DEFAULT_ROUTER_URL_OPTIONS, { mode: 'history', base: '/', query: {} });
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
  it('appends the configured query inside the hash so vue-router sees it', () => {
    // 财达的登录守卫认 to.query.channel，hash 路由下查询串必须写在 # 之内，
    // 写在 # 外面只进 window.location.search，vue-router 读不到。
    assert.equal(
      toBrowserUrl('/credit/amount/finance', {
        mode: 'hash',
        query: { channel: 'cdgst' },
      }),
      '/#/credit/amount/finance?channel=cdgst',
    );
  });

  it('appends the query for history mode too', () => {
    assert.equal(
      toBrowserUrl('/credit/amount', { mode: 'history', query: { channel: 'cdgst' } }),
      '/credit/amount?channel=cdgst',
    );
  });

  it('keeps the base before the hash when a query is configured', () => {
    assert.equal(
      toBrowserUrl('/a', { mode: 'hash', base: '/trade/', query: { k: 'v' } }),
      '/trade/#/a?k=v',
    );
  });

  it('encodes query values and preserves declaration order', () => {
    assert.equal(
      toBrowserUrl('/a', { mode: 'hash', query: { b: '1 2', a: 'x&y' } }),
      '/#/a?b=1%202&a=x%26y',
    );
  });

  it('is unchanged when no query is configured', () => {
    assert.equal(toBrowserUrl('/a', { mode: 'hash' }), '/#/a');
    assert.equal(toBrowserUrl('/a', { mode: 'hash', query: {} }), '/#/a');
  });

  it('relaxes a trailing anchor in the guard pattern when a query is configured', () => {
    for (const mode of ['hash', 'history'] as const) {
      const pattern = new RegExp(toGuardPattern('/checkout$', { mode, query: { channel: 'cdgst' } }));
      const prefix = mode === 'hash' ? 'http://fixture.test/#' : 'http://fixture.test';
      assert.equal(pattern.test(`${prefix}/checkout?channel=cdgst`), true);
      assert.equal(pattern.test(`${prefix}/checkout`), true);
      assert.equal(pattern.test(`${prefix}/checkout-other?channel=cdgst`), false);
    }
    // 没有查询串时保持原样
    assert.equal(toGuardPattern('/checkout$', { mode: 'hash' }), '#/checkout$');
  });

  it('restores an application route from a hash browser URL', () => {
    assert.equal(
      fromBrowserUrl('http://127.0.0.1:8080/#/iframePage', hash),
      '/iframePage',
    );
  });

  it('removes the base and query from a hash browser URL', () => {
    assert.equal(
      fromBrowserUrl('http://host/trade/#/a/b?x=1', {
        mode: 'hash',
        base: '/trade/',
      }),
      '/a/b',
    );
  });

  it('removes the base from a history browser URL', () => {
    assert.equal(
      fromBrowserUrl('http://host/trade/a/b?x=1', {
        mode: 'history',
        base: '/trade/',
      }),
      '/a/b',
    );
  });

  it('returns an empty string for invalid URLs or mismatched bases', () => {
    assert.equal(fromBrowserUrl('not a browser URL', history), '');
    assert.equal(
      fromBrowserUrl('http://host/other/a', { mode: 'history', base: '/trade/' }),
      '',
    );
    assert.equal(
      fromBrowserUrl('http://host/other/#/a', { mode: 'hash', base: '/trade/' }),
      '',
    );
  });
});
