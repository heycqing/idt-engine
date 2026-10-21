import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractVueRouterMappings } from '../../../src/idt/extract/vue-router.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'idt-vue-router-'));
}

function writeFile(root: string, relPath: string, source: string): void {
  const filePath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source, 'utf8');
}

describe('vue router extraction', () => {
  it('maps a wrapped dynamic import to its top-level route', () => {
    const root = createTempDir();
    try {
      writeFile(root, 'src/views/home/index.vue', '<template><div>首页</div></template>');
      writeFile(
        root,
        'src/router/index.js',
        `
        const Home = createRetryableRouteLoader(() => import('@/views/home'))
        export default [{ path: '/home', component: Home }]
        `,
      );

      const result = extractVueRouterMappings(root, ['src/router/**/*.{js,ts}']);
      const homePath = path.resolve(root, 'src/views/home/index.vue');

      assert.deepEqual(result.routesByComponent.get(homePath), ['/home']);
      assert.equal(result.routeRecordCount, 1);
      assert.equal(result.mappedRouteCount, 1);
      assert.deepEqual(result.unresolvedComponents, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves the @ alias from the nearest application src directory', () => {
    const root = createTempDir();
    try {
      writeFile(
        root,
        'apps/caida/src/views/home/index.vue',
        '<template><div>财达首页</div></template>',
      );
      writeFile(
        root,
        'apps/caida/src/router/index.js',
        `
        const Home = wrapper(() => import('@/views/home'))
        export default [{ path: '/home', component: Home }]
        `,
      );

      const result = extractVueRouterMappings(root, ['apps/caida/src/router/**/*.js']);

      assert.deepEqual(
        result.routesByComponent.get(path.resolve(root, 'apps/caida/src/views/home/index.vue')),
        ['/home'],
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('joins relative child paths and preserves absolute child paths', () => {
    const root = createTempDir();
    try {
      for (const relPath of [
        'src/views/trade/index.vue',
        'src/views/trade/buy/index.vue',
        'src/views/absolute/index.vue',
      ]) {
        writeFile(root, relPath, '<template><div>页面</div></template>');
      }
      writeFile(
        root,
        'src/router/index.js',
        `
        const Shell = () => import('@/views/trade')
        const Buy = () => import('@/views/trade/buy')
        const Absolute = () => import('@/views/absolute')
        export default [{
          path: '/trade',
          component: Shell,
          children: [
            { path: 'buy', component: Buy },
            { path: '/absolute', component: Absolute },
          ],
        }]
        `,
      );

      const result = extractVueRouterMappings(root, ['src/router/**/*.{js,ts}']);

      assert.deepEqual(
        result.routesByComponent.get(path.resolve(root, 'src/views/trade/index.vue')),
        ['/trade'],
      );
      assert.deepEqual(
        result.routesByComponent.get(path.resolve(root, 'src/views/trade/buy/index.vue')),
        ['/trade/buy'],
      );
      assert.deepEqual(
        result.routesByComponent.get(path.resolve(root, 'src/views/absolute/index.vue')),
        ['/absolute'],
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves named imports and local aliases across router modules', () => {
    const root = createTempDir();
    try {
      writeFile(root, 'src/views/trade/buy/index.vue', '<template><div>买入</div></template>');
      writeFile(root, 'src/credit/views/home/index.vue', '<template><div>信用首页</div></template>');
      writeFile(
        root,
        'src/router/tradeLoaders.js',
        `export const loadBuy = wrapper(() => import('@/views/trade/buy'))`,
      );
      writeFile(
        root,
        'src/credit/router/index.js',
        `
        const CreditHome = wrapper(() => import('@/credit/views/home'))
        export default [{ path: '/credit/home', component: CreditHome }]
        `,
      );
      writeFile(
        root,
        'src/router/index.js',
        `
        import creditRoutes from '@/credit/router'
        import { loadBuy } from './tradeLoaders'
        const TradeBuy = loadBuy
        export const routes = [{ path: '/trade/buy', component: TradeBuy }]
        export default routes.concat(creditRoutes)
        `,
      );

      const result = extractVueRouterMappings(root, [
        'src/router/**/*.{js,ts}',
        'src/credit/router/**/*.{js,ts}',
      ]);

      assert.deepEqual(
        result.routesByComponent.get(path.resolve(root, 'src/views/trade/buy/index.vue')),
        ['/trade/buy'],
      );
      assert.deepEqual(
        result.routesByComponent.get(path.resolve(root, 'src/credit/views/home/index.vue')),
        ['/credit/home'],
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses router glob order to select the preferred component for duplicate routes', () => {
    const root = createTempDir();
    try {
      writeFile(root, 'apps/demo/src/views/transfer/index.vue', '<template />');
      writeFile(root, 'apps/demo/src/credit/views/transfer/index.vue', '<template />');
      writeFile(
        root,
        'apps/demo/src/router/index.js',
        `
        const Transfer = () => import('@/views/transfer')
        export default [{ path: '/transfer', component: Transfer }]
        `,
      );
      writeFile(
        root,
        'apps/demo/src/credit/router/index.js',
        `
        const CreditTransfer = () => import('@/credit/views/transfer')
        export default [{ path: '/transfer', component: CreditTransfer }]
        `,
      );

      const result = extractVueRouterMappings(root, [
        'apps/demo/src/router/**/*.js',
        'apps/demo/src/credit/router/**/*.js',
      ]);

      assert.equal(
        result.preferredComponentByRoute.get('/transfer'),
        path.resolve(root, 'apps/demo/src/views/transfer/index.vue'),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('deduplicates repeated routes and reports dynamic component expressions', () => {
    const root = createTempDir();
    try {
      writeFile(root, 'src/views/shared/index.vue', '<template><div>共享页</div></template>');
      writeFile(
        root,
        'src/router/index.js',
        `
        const Shared = () => import('@/views/shared')
        const dynamicName = '@/views/unknown'
        export default [
          { path: '/shared', component: Shared },
          { path: '/shared', component: Shared },
          { path: '/shared-alt', component: Shared },
          { path: '/dynamic', component: () => import(dynamicName) },
        ]
        // { path: '/commented', component: Shared }
        `,
      );

      const result = extractVueRouterMappings(root, ['src/router/**/*.js']);

      assert.deepEqual(
        result.routesByComponent.get(path.resolve(root, 'src/views/shared/index.vue')),
        ['/shared', '/shared-alt'],
      );
      assert.equal(result.routeRecordCount, 4);
      assert.equal(result.mappedRouteCount, 3);
      assert.deepEqual(result.unresolvedComponents, ['() => import(dynamicName)']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns an empty result when router globs are not configured', () => {
    const result = extractVueRouterMappings('D:\\missing-project', []);

    assert.deepEqual([...result.routesByComponent], []);
    assert.equal(result.routeRecordCount, 0);
    assert.equal(result.mappedRouteCount, 0);
    assert.deepEqual(result.unresolvedComponents, []);
  });
});
