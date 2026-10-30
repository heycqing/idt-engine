import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBatchExcludes,
  selectBatchRoutes,
} from '../../../src/idt/core/batch-routes.js';

const topology = {
  routes: {
    '/': { elements: [{ role: 'heading', name: '首页' }] },
    '/trade/home': { elements: [{ role: 'button', name: '买入' }] },
    '/credit/home': { elements: [{ role: 'button', name: '担保品' }] },
    '/credit/finance/buy': { elements: [{ role: 'button', name: '买入' }] },
    '/plan/list': { elements: [{ role: 'text', name: '条件单' }] },
    '/no-elements': { elements: [] },
    '/only-dynamic': { elements: [{ role: 'button', dynamic: true, tag: 'div' }] },
    '/only-named-dynamic': { elements: [{ role: 'button', name: '运行期按钮', dynamic: true }] },
    '/only-deferred': { elements: [{ role: 'button', name: '弹窗按钮', deferred: true }] },
    '/only-data-scoped': { elements: [{ role: 'button', name: '逐行按钮', dataScoped: true }] },
  },
} as any;

describe('batch route selection', () => {
  it('keeps only routes that have at least one named element', () => {
    const routes = selectBatchRoutes(topology, { exclude: [] });
    assert.equal(routes.includes('/no-elements'), false);
    assert.equal(routes.includes('/only-dynamic'), false, 'dynamic 没有名字，断言不了');
    assert.equal(routes.includes('/only-named-dynamic'), false, '即使残留名字也不能拿 dynamic 元素断言就绪');
    assert.equal(routes.includes('/only-deferred'), false, '未触发弹窗时不能拿 deferred 元素断言就绪');
    assert.equal(routes.includes('/only-data-scoped'), false, '没有后端行数据时不能拿 dataScoped 元素断言就绪');
    assert.deepEqual(routes, [
      '/',
      '/credit/finance/buy',
      '/credit/home',
      '/plan/list',
      '/trade/home',
    ]);
  });

  it('excludes by substring', () => {
    // 白名单型券商的 credit 路由永远被守卫重定向，批量时要排掉
    assert.deepEqual(selectBatchRoutes(topology, { exclude: ['/credit'] }), [
      '/',
      '/plan/list',
      '/trade/home',
    ]);
  });

  it('combines filter and exclude', () => {
    assert.deepEqual(
      selectBatchRoutes(topology, { filter: '/credit', exclude: ['finance'] }),
      ['/credit/home'],
    );
  });

  it('applies limit after filtering', () => {
    assert.deepEqual(selectBatchRoutes(topology, { exclude: ['/credit'], limit: 2 }), [
      '/',
      '/plan/list',
    ]);
  });

  it('accepts several normalized exclude substrings', () => {
    assert.deepEqual(selectBatchRoutes(topology, { exclude: ['/credit', '/trade'] }), [
      '/',
      '/plan/list',
    ]);
  });

  it('tolerates a topology whose nodes predate the elements field', () => {
    const legacy = { routes: { '/a': {}, '/b': { elements: [{ role: 'button', name: 'x' }] } } } as any;
    assert.deepEqual(selectBatchRoutes(legacy, { exclude: [] }), ['/b']);
  });
});

describe('batch exclude normalization', () => {
  it('uses the marker value when the command line omits exclude', () => {
    const exclude = normalizeBatchExcludes(undefined, ['credit', 'trade/home']);

    assert.deepEqual(selectBatchRoutes(topology, { exclude }), ['/', '/plan/list']);
  });

  it('lets an explicit command-line value completely replace the marker value', () => {
    const exclude = normalizeBatchExcludes(' plan , ,trade/home ', ['credit']);

    assert.deepEqual(selectBatchRoutes(topology, { exclude }), [
      '/',
      '/credit/finance/buy',
      '/credit/home',
    ]);
  });

  it('returns no exclusions when neither source provides one', () => {
    const exclude = normalizeBatchExcludes(undefined, undefined);

    assert.deepEqual(selectBatchRoutes(topology, { exclude }), [
      '/',
      '/credit/finance/buy',
      '/credit/home',
      '/plan/list',
      '/trade/home',
    ]);
  });
});
