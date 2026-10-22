import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractProjectTopology, readSemanticIndex } from '../../../src/idt/extract/topology.js';
import { findRoutePath } from '../../../src/idt/core/pathfinder.js';
import type { ProjectTopology, SemanticIndex } from '../../../src/idt/schemas/topology.schema.js';

function createTempDir(prefix = 'idt-path-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

function writeFile(dir: string, relPath: string, content: string): void {
  const fullPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

describe('pathfinder', () => {
  it('Requirement 1 & 4: Three-page fixture pathfinding and single page match', () => {
    const tmp = createTempDir();
    try {
      // 1. src/pages/cart/index.tsx
      writeFile(
        tmp,
        'src/pages/cart/index.tsx',
        `
        import React from 'react';
        export default function Cart() {
          return (
            <div>
              <button onClick={() => navigate('/checkout')}>去结算</button>
            </div>
          );
        }
        `
      );

      // 2. src/pages/checkout/index.tsx
      writeFile(
        tmp,
        'src/pages/checkout/index.tsx',
        `
        import React from 'react';
        export default function Checkout() {
          const handlePay = () => {
            fetch('/api/orders', { method: 'POST' });
            navigate('/checkout/success');
          };
          return (
            <div>
              <button onClick={handlePay}>立即支付</button>
            </div>
          );
        }
        `
      );

      // 3. src/pages/checkout/success/index.tsx
      writeFile(
        tmp,
        'src/pages/checkout/success/index.tsx',
        `
        import React from 'react';
        export default function Success() {
          return <div>支付成功</div>;
        }
        `
      );

      const topology = extractProjectTopology(tmp);
      const semanticIndex = readSemanticIndex(tmp);

      // Requirement 1: 购物车去结算并支付成功 -> ['/cart', '/checkout', '/checkout/success']
      const res = findRoutePath(
        topology,
        semanticIndex,
        '购物车去结算并支付成功'
      );
      assert.deepEqual(res.routePath, [
        '/cart',
        '/checkout',
        '/checkout/success',
      ]);
      assert.equal(res.start, '/cart');
      assert.equal(res.end, '/checkout/success');

      // Requirement 4: Only 1 page hit -> routePath.length === 1
      const singleRes = findRoutePath(topology, semanticIndex, '去结算');
      assert.equal(singleRes.routePath.length, 1);
      assert.deepEqual(singleRes.routePath, ['/cart']);
    } finally {
      removeTempDir(tmp);
    }
  });

  it('Requirement 2: Unknown intent throws exitCode 2 with message containing idt:sync', () => {
    const tmp = createTempDir();
    try {
      writeFile(
        tmp,
        'src/pages/cart/index.tsx',
        `export default function Cart() { return <div>购物车</div>; }`
      );
      const topology = extractProjectTopology(tmp);
      const semanticIndex = readSemanticIndex(tmp);

      assert.throws(
        () => findRoutePath(topology, semanticIndex, '完全不存在的黑话zzzz'),
        (err: any) => {
          assert.equal(err.exitCode, 2);
          assert.ok(
            err.message.includes('idt:sync'),
            `Expected message to contain idt:sync, got: ${err.message}`
          );
          return true;
        }
      );
    } finally {
      removeTempDir(tmp);
    }
  });

  it('Requirement 3: Two pages match but have no edges -> throws exitCode 2 with both paths', () => {
    const tmp = createTempDir();
    try {
      writeFile(
        tmp,
        'src/pages/feed/index.tsx',
        `export default function Feed() { return <div>浏览动态</div>; }`
      );
      writeFile(
        tmp,
        'src/pages/settings/index.tsx',
        `export default function Settings() { return <div>系统设置</div>; }`
      );

      const topology = extractProjectTopology(tmp);
      const semanticIndex = readSemanticIndex(tmp);

      assert.throws(
        () => findRoutePath(topology, semanticIndex, '浏览动态系统设置'),
        (err: any) => {
          assert.equal(err.exitCode, 2);
          assert.ok(
            err.message.includes('/feed') && err.message.includes('/settings'),
            `Expected message to contain both /feed and /settings, got: ${err.message}`
          );
          return true;
        }
      );
    } finally {
      removeTempDir(tmp);
    }
  });

  it('Requirement 5: Handwritten topology: /start points to /b and /a, both point to /end -> routePath is [/start, /a, /end]', () => {
    const topology: ProjectTopology = {
      version: '1.0.0',
      generatedAt: '2026-01-01T00:00:00.000Z',
      sourceDigest: '0'.repeat(64),
      routes: {
        '/start': {
          path: '/start',
          filePath: 'src/pages/start.tsx',
          title: 'start',
          semanticKeywords: ['起点'],
          elements: [],
          dynamicParams: [],
          transitions: [
            {
              targetRoute: '/b',
              triggerType: 'CLICK',
              codeSlice: '',
            },
            {
              targetRoute: '/a',
              triggerType: 'CLICK',
              codeSlice: '',
            },
          ],
        },
        '/a': {
          path: '/a',
          filePath: 'src/pages/a.tsx',
          title: 'a',
          semanticKeywords: [],
          elements: [],
          dynamicParams: [],
          transitions: [
            {
              targetRoute: '/end',
              triggerType: 'CLICK',
              codeSlice: '',
            },
          ],
        },
        '/b': {
          path: '/b',
          filePath: 'src/pages/b.tsx',
          title: 'b',
          semanticKeywords: [],
          elements: [],
          dynamicParams: [],
          transitions: [
            {
              targetRoute: '/end',
              triggerType: 'CLICK',
              codeSlice: '',
            },
          ],
        },
        '/end': {
          path: '/end',
          filePath: 'src/pages/end.tsx',
          title: 'end',
          semanticKeywords: ['终点'],
          elements: [],
          dynamicParams: [],
          transitions: [],
        },
      },
    };

    const semanticIndex: SemanticIndex = {
      version: '1.0.0',
      sourceDigest: '0'.repeat(64),
      entries: [
        { keyword: '起点', route: '/start', kind: 'text' },
        { keyword: '终点', route: '/end', kind: 'text' },
      ],
    };

    const res = findRoutePath(topology, semanticIndex, '从起点到达终点');
    assert.deepEqual(res.routePath, ['/start', '/a', '/end']);
    assert.equal(res.start, '/start');
    assert.equal(res.end, '/end');
  });

  it('Requirement 6: Handwritten topology: transition targetRoute /goods/1 matches /goods/:id -> BFS reaches /goods/:id', () => {
    const topology: ProjectTopology = {
      version: '1.0.0',
      generatedAt: '2026-01-01T00:00:00.000Z',
      sourceDigest: '0'.repeat(64),
      routes: {
        '/goods': {
          path: '/goods',
          filePath: 'src/pages/goods/index.tsx',
          title: 'goods',
          semanticKeywords: ['商品列表'],
          elements: [],
          dynamicParams: [],
          transitions: [
            {
              targetRoute: '/goods/1',
              triggerType: 'CLICK',
              codeSlice: '',
            },
          ],
        },
        '/goods/:id': {
          path: '/goods/:id',
          filePath: 'src/pages/goods/[id].tsx',
          title: 'goods-detail',
          semanticKeywords: ['商品详情'],
          elements: [],
          dynamicParams: ['id'],
          transitions: [],
        },
      },
    };

    const semanticIndex: SemanticIndex = {
      version: '1.0.0',
      sourceDigest: '0'.repeat(64),
      entries: [
        { keyword: '商品列表', route: '/goods', kind: 'text' },
        { keyword: '商品详情', route: '/goods/:id', kind: 'text' },
      ],
    };

    const res = findRoutePath(topology, semanticIndex, '商品列表查看商品详情');
    assert.deepEqual(res.routePath, ['/goods', '/goods/:id']);
    assert.equal(res.start, '/goods');
    assert.equal(res.end, '/goods/:id');
  });
  it('drops a candidate whose matched keywords are all matched by another candidate', () => {
    // 真实宿主上踩到的：意图里的"全部"同时命中融资页和融券页，而融券页只命中
    // 这一个词、融资页还命中了"拟调整融资额度"。融券页没提供任何新信息，
    // 却把寻径变成了一次注定失败的跨页搜索。
    const topology: ProjectTopology = {
      version: '1.0.0',
      generatedAt: '2026-10-21T00:00:00.000Z',
      sourceDigest: 'a'.repeat(64),
      routes: {
        '/credit/amount/finance': {
          path: '/credit/amount/finance',
          filePath: 'src/views/finance/index.vue',
          title: 'index',
          semanticKeywords: ['拟调整融资额度', '全部'],
          dynamicParams: [],
          transitions: [],
          elements: [],
        },
        '/credit/amount/securities': {
          path: '/credit/amount/securities',
          filePath: 'src/views/securities/index.vue',
          title: 'index',
          semanticKeywords: ['全部'],
          dynamicParams: [],
          transitions: [],
          elements: [],
        },
      },
    };
    const semanticIndex: SemanticIndex = {
      version: '1.0.0',
      sourceDigest: 'a'.repeat(64),
      entries: [
        { keyword: '拟调整融资额度', route: '/credit/amount/finance', kind: 'text' },
        { keyword: '全部', route: '/credit/amount/finance', kind: 'text' },
        { keyword: '全部', route: '/credit/amount/securities', kind: 'text' },
      ],
    };

    const result = findRoutePath(topology, semanticIndex, '打开拟调整融资额度页面并点击全部按钮');
    assert.deepEqual(result.routePath, ['/credit/amount/finance']);
    assert.deepEqual(result.candidates, ['/credit/amount/finance']);
  });

  it('keeps genuinely distinct candidates so multi-page flows still work', () => {
    const topology: ProjectTopology = {
      version: '1.0.0',
      generatedAt: '2026-10-21T00:00:00.000Z',
      sourceDigest: 'b'.repeat(64),
      routes: {
        '/cart': {
          path: '/cart',
          filePath: 'src/views/cart/index.vue',
          title: 'index',
          semanticKeywords: ['购物车'],
          dynamicParams: [],
          transitions: [
            { targetRoute: '/checkout', triggerType: 'CLICK', codeSlice: 'go()' },
          ],
          elements: [],
        },
        '/checkout': {
          path: '/checkout',
          filePath: 'src/views/checkout/index.vue',
          title: 'index',
          semanticKeywords: ['结算'],
          dynamicParams: [],
          transitions: [],
          elements: [],
        },
      },
    };
    const semanticIndex: SemanticIndex = {
      version: '1.0.0',
      sourceDigest: 'b'.repeat(64),
      entries: [
        { keyword: '购物车', route: '/cart', kind: 'text' },
        { keyword: '结算', route: '/checkout', kind: 'text' },
      ],
    };

    const result = findRoutePath(topology, semanticIndex, '从购物车去结算');
    assert.deepEqual(result.routePath, ['/cart', '/checkout']);
  });

  it('explains which keyword pulled in each candidate when no path exists', () => {
    const topology: ProjectTopology = {
      version: '1.0.0',
      generatedAt: '2026-10-21T00:00:00.000Z',
      sourceDigest: 'c'.repeat(64),
      routes: {
        '/home': {
          path: '/home',
          filePath: 'src/views/home/index.vue',
          title: 'index',
          semanticKeywords: ['账户资金及盈亏'],
          dynamicParams: [],
          transitions: [],
          elements: [],
        },
        '/transfer/today': {
          path: '/transfer/today',
          filePath: 'src/views/transfer/today/index.vue',
          title: 'index',
          semanticKeywords: ['操作'],
          dynamicParams: [],
          transitions: [],
          elements: [],
        },
      },
    };
    const semanticIndex: SemanticIndex = {
      version: '1.0.0',
      sourceDigest: 'c'.repeat(64),
      entries: [
        { keyword: '账户资金及盈亏', route: '/home', kind: 'text' },
        { keyword: '操作', route: '/transfer/today', kind: 'text' },
      ],
    };

    assert.throws(
      () => findRoutePath(topology, semanticIndex, '打开账户资金及盈亏页面，不要执行任何操作'),
      (err: any) => {
        assert.equal(err.exitCode, 2);
        // 必须说清每个候选是被哪个词拉进来的，否则使用者无从下手
        assert.match(err.message, /\/home/);
        assert.match(err.message, /账户资金及盈亏/);
        assert.match(err.message, /\/transfer\/today/);
        assert.match(err.message, /操作/);
        return true;
      },
    );
  });
});
