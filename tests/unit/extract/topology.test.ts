import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { extractProjectTopology, readTopology } from '../../../src/idt/extract/topology.js';
import {
  ProjectTopologySchema,
  SemanticIndexSchema,
} from '../../../src/idt/schemas/topology.schema.js';
import { DEFAULT_IDT_CONFIG, loadIdtConfig } from '../../../src/idt/config/load.js';

function createTempDir(prefix = 'idt-test-'): string {
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

describe('topology extraction and semantic index', () => {
  it('loads router globs and defaults them to an empty list', () => {
    const tmp = createTempDir();
    try {
      writeFile(
        tmp,
        'idt.config.ts',
        `export default {
          pageGlobs: ['src/views/**/*.vue'],
          localeFiles: [],
          routerGlobs: ['src/router/**/*.{js,ts}'],
        };`,
      );

      assert.deepEqual(loadIdtConfig(tmp).routerGlobs, ['src/router/**/*.{js,ts}']);
      assert.deepEqual(DEFAULT_IDT_CONFIG.routerGlobs, []);
    } finally {
      removeTempDir(tmp);
    }
  });

  it('Requirement 2: Three-page fixture, sourceDigest consistency, and schema validation', () => {
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

      // Extract twice
      const topo1 = extractProjectTopology(tmp);
      const topo2 = extractProjectTopology(tmp);

      // sourceDigest must be identical
      assert.equal(topo1.sourceDigest, topo2.sourceDigest);
      assert.equal(topo1.sourceDigest.length, 64);

      // Route keys exactly /cart, /checkout, /checkout/success
      const routeKeys = Object.keys(topo1.routes).sort();
      assert.deepEqual(routeKeys, ['/cart', '/checkout', '/checkout/success']);

      // /cart transition
      const cartNode = topo1.routes['/cart'];
      assert.ok(cartNode);
      assert.equal(cartNode.filePath, 'src/pages/cart/index.tsx');
      assert.equal(cartNode.transitions.length, 1);
      assert.equal(cartNode.transitions[0].targetRoute, '/checkout');
      assert.equal(cartNode.transitions[0].triggerType, 'CLICK');
      assert.equal(cartNode.transitions[0].triggerElementText, '去结算');
      assert.ok(cartNode.transitions[0].codeSlice.split('\n').length <= 200);

      // /checkout transition
      const checkoutNode = topo1.routes['/checkout'];
      assert.ok(checkoutNode);
      assert.equal(checkoutNode.filePath.includes('\\'), false);
      assert.equal(checkoutNode.transitions.length, 1);
      assert.equal(checkoutNode.transitions[0].targetRoute, '/checkout/success');
      assert.equal(checkoutNode.transitions[0].triggerType, 'CLICK');
      assert.equal(checkoutNode.transitions[0].triggerElementText, '立即支付');
      assert.ok(checkoutNode.transitions[0].codeSlice.includes('fetch('));
      assert.ok(checkoutNode.transitions[0].codeSlice.split('\n').length <= 200);

      // /checkout/success
      const successNode = topo1.routes['/checkout/success'];
      assert.ok(successNode);
      assert.equal(successNode.filePath.includes('\\'), false);

      // Check written JSON files
      const topoJson = JSON.parse(
        fs.readFileSync(path.join(tmp, '.idt/topology.json'), 'utf8')
      );
      const semJson = JSON.parse(
        fs.readFileSync(path.join(tmp, '.idt/semantic-index.json'), 'utf8')
      );

      const parsedTopo = ProjectTopologySchema.parse(topoJson);
      const parsedSem = SemanticIndexSchema.parse(semJson);

      assert.equal(parsedTopo.sourceDigest, parsedSem.sourceDigest);

      // Semantic index keywords
      const semEntries = parsedSem.entries;
      const cartKeywords = semEntries.filter((e) => e.route === '/cart').map((e) => e.keyword);
      assert.ok(cartKeywords.includes('去结算'));

      const checkoutKeywords = semEntries
        .filter((e) => e.route === '/checkout')
        .map((e) => e.keyword);
      assert.ok(checkoutKeywords.includes('立即支付'));

      const successKeywords = semEntries
        .filter((e) => e.route === '/checkout/success')
        .map((e) => e.keyword);
      assert.ok(successKeywords.includes('支付成功'));
    } finally {
      removeTempDir(tmp);
    }
  });

  it('Requirement 3: Second pass normalization matches concrete route to pattern route', () => {
    const tmp = createTempDir();
    try {
      // Goods detail page
      writeFile(
        tmp,
        'src/pages/goods/[id].tsx',
        `
        import React from 'react';
        export default function GoodsDetail() {
          return <div>商品详情</div>;
        }
        `
      );

      // Another page navigating to concrete /goods/1
      writeFile(
        tmp,
        'src/pages/home/index.tsx',
        `
        import React from 'react';
        export default function Home() {
          return <button onClick={() => navigate('/goods/1')}>查看商品</button>;
        }
        `
      );

      const topo = extractProjectTopology(tmp);
      const goodsNode = topo.routes['/goods/:id'];
      assert.ok(goodsNode);
      assert.deepEqual(goodsNode.dynamicParams, ['id']);

      const homeNode = topo.routes['/home'];
      assert.ok(homeNode);
      assert.equal(homeNode.transitions.length, 1);
      assert.equal(homeNode.transitions[0].targetRoute, '/goods/:id');
    } finally {
      removeTempDir(tmp);
    }
  });

  it('pages catch-all files are excluded from the topology', () => {
    const tmp = createTempDir();
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '));
    };
    try {
      writeFile(
        tmp,
        'src/pages/docs/[...slug].tsx',
        `
        export default function Docs() {
          return <div>文档</div>;
        }
        `
      );
      writeFile(
        tmp,
        'src/pages/cart/index.tsx',
        `
        export default function Cart() {
          return <div>购物车</div>;
        }
        `
      );

      const topo = extractProjectTopology(tmp);
      assert.deepEqual(Object.keys(topo.routes), ['/cart']);
      assert.ok(logs.some((line) => line.includes('catch-all')));
    } finally {
      console.log = originalLog;
      removeTempDir(tmp);
    }
  });

  it('Requirement 4: Template string navigation replaces interpolations with :param', () => {
    const tmp = createTempDir();
    try {
      writeFile(
        tmp,
        'src/pages/goods/index.tsx',
        `
        import React from 'react';
        export default function Goods() {
          const id = '123';
          const toReviews = () => {
            navigate(\`/goods/\${id}/reviews\`);
          };
          return <button onClick={toReviews}>评价</button>;
        }
        `
      );

      const topo = extractProjectTopology(tmp);
      const goodsNode = topo.routes['/goods'];
      assert.ok(goodsNode);
      assert.equal(goodsNode.transitions.length, 1);
      assert.equal(goodsNode.transitions[0].targetRoute, '/goods/:param/reviews');
    } finally {
      removeTempDir(tmp);
    }
  });

  it('Requirement 5: Link component produces CLICK edge and triggerElementText', () => {
    const tmp = createTempDir();
    try {
      writeFile(
        tmp,
        'src/pages/cart/index.tsx',
        `
        import React from 'react';
        import { Link } from 'react-router-dom';
        export default function Cart() {
          return (
            <div>
              <Link to="/checkout">去购物车结算</Link>
            </div>
          );
        }
        `
      );

      const topo = extractProjectTopology(tmp);
      const cartNode = topo.routes['/cart'];
      assert.ok(cartNode);
      assert.equal(cartNode.transitions.length, 1);
      assert.equal(cartNode.transitions[0].targetRoute, '/checkout');
      assert.equal(cartNode.transitions[0].triggerType, 'CLICK');
      assert.equal(cartNode.transitions[0].triggerElementText, '去购物车结算');
    } finally {
      removeTempDir(tmp);
    }
  });

  it('Requirement 6: i18n resolution with nested keys and missing keys', () => {
    const tmp = createTempDir();
    try {
      // idt.config.ts with custom locale file
      writeFile(
        tmp,
        'idt.config.ts',
        `
        export default {
          pageGlobs: ['src/pages/**/*.{tsx,jsx,ts,js}'],
          localeFiles: ['locales/zh-CN.json'],
        };
        `
      );

      writeFile(
        tmp,
        'locales/zh-CN.json',
        JSON.stringify({
          pay: {
            now: '马上付',
          },
        })
      );

      writeFile(
        tmp,
        'src/pages/pay/index.tsx',
        `
        import React from 'react';
        export default function Pay() {
          return (
            <div>
              <button>{t('pay.now')}</button>
              <span>{t('missing.key')}</span>
            </div>
          );
        }
        `
      );

      const topo = extractProjectTopology(tmp);
      const payNode = topo.routes['/pay'];
      assert.ok(payNode);
      assert.ok(payNode.semanticKeywords.includes('马上付'));
      assert.ok(payNode.semanticKeywords.includes('i18n:missing.key'));

      const semJson = JSON.parse(
        fs.readFileSync(path.join(tmp, '.idt/semantic-index.json'), 'utf8')
      );
      const entries = semJson.entries;

      const hit = entries.find((e: any) => e.keyword === '马上付' && e.route === '/pay');
      assert.ok(hit);
      assert.equal(hit.kind, 'i18n');

      const missing = entries.find(
        (e: any) => e.keyword === 'i18n:missing.key' && e.route === '/pay'
      );
      assert.ok(missing);
      assert.equal(missing.kind, 'i18n');
    } finally {
      removeTempDir(tmp);
    }
  });

  it('Requirement 7: Truncation limits codeSlice to 200 lines with /* idt-truncated */', () => {
    const tmp = createTempDir();
    try {
      // Build a function with 250 lines
      const paddingLines = Array.from(
        { length: 240 },
        (_, i) => `    console.log('line ${i}');`
      ).join('\n');

      writeFile(
        tmp,
        'src/pages/checkout/index.tsx',
        `
        import React from 'react';
        export default function Checkout() {
          const handleCheckout = () => {
            navigate('/checkout');
${paddingLines}
          };
          return <button onClick={handleCheckout}>结算</button>;
        }
        `
      );

      const topo = extractProjectTopology(tmp);
      const checkoutNode = topo.routes['/checkout'];
      assert.ok(checkoutNode);
      assert.equal(checkoutNode.transitions.length, 1);

      const slice = checkoutNode.transitions[0].codeSlice;
      const lines = slice.split('\n');
      assert.ok(lines.length <= 200);
      assert.equal(lines[lines.length - 1], '/* idt-truncated */');
    } finally {
      removeTempDir(tmp);
    }
  });

  it('Requirement 8: readTopology re-extracts and heals invalid topology file', () => {
    const tmp = createTempDir();
    try {
      writeFile(
        tmp,
        'src/pages/cart/index.tsx',
        `
        import React from 'react';
        export default function Cart() {
          return <div>购物车</div>;
        }
        `
      );

      const idtDir = path.join(tmp, '.idt');
      fs.mkdirSync(idtDir, { recursive: true });
      fs.writeFileSync(
        path.join(idtDir, 'topology.json'),
        JSON.stringify({ version: 'nope' }),
        'utf8'
      );

      const topo = readTopology(tmp);
      assert.equal(topo.version, '1.0.0');
      assert.ok(topo.routes['/cart']);

      // File on disk was overwritten with valid topology
      const onDisk = JSON.parse(fs.readFileSync(path.join(idtDir, 'topology.json'), 'utf8'));
      assert.equal(onDisk.version, '1.0.0');
    } finally {
      removeTempDir(tmp);
    }
  });

  it('Requirement 9: CLI sync returns exit code 0 on valid fixture and code 2 on invalid config', () => {
    const cliPath = path.resolve('scripts/idt/cli.ts');
    const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

    // Case 1: valid fixture
    const tmpValid = createTempDir();
    try {
      writeFile(
        tmpValid,
        'src/pages/index.tsx',
        `
        import React from 'react';
        export default function Home() {
          return <div>Home</div>;
        }
        `
      );

      const res = spawnSync(
        process.execPath,
        ['--import', tsxImport, cliPath, 'sync'],
        {
          cwd: tmpValid,
          encoding: 'utf8',
        }
      );

      assert.equal(res.status, 0, `CLI failed with stderr: ${res.stderr}`);
      assert.ok(res.stdout.includes('topology.json'));
      assert.ok(res.stdout.includes('semantic-index.json'));
      assert.ok(fs.existsSync(path.join(tmpValid, '.idt/topology.json')));
      assert.ok(fs.existsSync(path.join(tmpValid, '.idt/semantic-index.json')));
    } finally {
      removeTempDir(tmpValid);
    }

    // Case 2: invalid config (pageGlobs: []) -> exit code 2
    const tmpInvalid = createTempDir();
    try {
      writeFile(
        tmpInvalid,
        'idt.config.ts',
        `
        export default {
          pageGlobs: [],
        };
        `
      );

      const res = spawnSync(
        process.execPath,
        ['--import', tsxImport, cliPath, 'sync'],
        {
          cwd: tmpInvalid,
          encoding: 'utf8',
        }
      );

      assert.equal(res.status, 2, `Expected exit code 2 but got ${res.status}: ${res.stdout} ${res.stderr}`);
    } finally {
      removeTempDir(tmpInvalid);
    }
  });

  it('reads Vue single-file pages by file path and literal jumps', () => {
    const tmp = createTempDir();
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '));
    };
    try {
      writeFile(
        tmp,
        'src/locales/zh-CN.json',
        JSON.stringify({ trade: { buy: '买入' } }),
      );
      writeFile(
        tmp,
        'src/views/transfer/today/index.vue',
        `
        <template>
          <div class="history flex">
            <router-link to="/statement/history">历史成交</router-link>
            <router-link :to="{ path: '/subscribe/lucky' }">中签</router-link>
            <button @click="goCart">去结算</button>
            <span>{{ $t('trade.buy') }}</span>
            <!-- <router-link to="/subscribe/plan">计划</router-link> -->
          </div>
        </template>
        <script>
        export default {
          methods: {
            goCart() {
              this.$router.push('/cart')
            },
            goHome() {
              this.$router.replace({ path: '/credit/home', query })
            },
            goDynamic() {
              const content = '/nope'
              this.$router.push(content)
            }
          }
        }
        </script>
        `,
      );
      writeFile(
        tmp,
        'src/views/cart/index.vue',
        `
        <template>
          <button @click="goCheckout">去下单</button>
        </template>
        <script setup>
        function goCheckout() {
          router.push('/checkout')
        }
        </script>
        `,
      );
      writeFile(
        tmp,
        'src/views/docs/[...slug].vue',
        `<template><div>文档</div></template>`,
      );

      const topo = extractProjectTopology(tmp);
      assert.equal(topo.routes['/transfer/today'].filePath, 'src/views/transfer/today/index.vue');
      const jumps = new Map(topo.routes['/transfer/today'].transitions.map((item) => [item.targetRoute, item]));
      assert.equal(jumps.size, 4);
      assert.equal(jumps.get('/statement/history')?.triggerType, 'CLICK');
      assert.equal(jumps.get('/statement/history')?.triggerElementText, '历史成交');
      assert.equal(jumps.get('/subscribe/lucky')?.triggerElementText, '中签');
      assert.equal(jumps.get('/cart')?.triggerType, 'CLICK');
      assert.equal(jumps.get('/cart')?.triggerElementText, '去结算');
      assert.match(jumps.get('/cart')?.codeSlice ?? '', /\$router\.push/);
      assert.equal(jumps.get('/credit/home')?.triggerType, 'PROGRAMMATIC');
      assert.equal(jumps.has('/subscribe/plan'), false);
      assert.equal(jumps.has('/nope'), false);

      const keywords = topo.routes['/transfer/today'].semanticKeywords;
      assert.ok(keywords.includes('历史成交'));
      assert.ok(keywords.includes('买入'));
      assert.equal(keywords.includes('history flex'), false);
      assert.equal(keywords.includes('计划'), false);

      const cart = topo.routes['/cart'];
      assert.equal(cart.transitions.length, 1);
      assert.equal(cart.transitions[0].targetRoute, '/checkout');
      assert.equal(cart.transitions[0].triggerType, 'CLICK');
      assert.equal(cart.transitions[0].triggerElementText, '去下单');
      assert.equal(topo.routes['/docs/[...slug]'], undefined);
      assert.ok(logs.some((line) => line.includes('catch-all')));

      const index = JSON.parse(fs.readFileSync(path.join(tmp, '.idt', 'semantic-index.json'), 'utf8'));
      const parsed = SemanticIndexSchema.parse(index);
      const buy = parsed.entries.find((entry) => entry.keyword === '买入');
      assert.equal(buy?.kind, 'i18n');
      assert.equal(buy?.route, '/transfer/today');
    } finally {
      console.log = originalLog;
      removeTempDir(tmp);
    }
  });

  it('uses Vue Router paths while preserving page semantics and transitions', () => {
    const tmp = createTempDir();
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    try {
      writeFile(
        tmp,
        'idt.config.ts',
        `export default {
          pageGlobs: ['src/views/**/*.vue'],
          routerGlobs: ['src/router/**/*.js'],
          localeFiles: [],
        };`,
      );
      writeFile(
        tmp,
        'src/views/subscribe/index.vue',
        `
        <template>
          <button @click="goMine">新股申购</button>
        </template>
        <script>
        export default {
          methods: {
            goMine() { this.$router.push('/subscribe/my') }
          }
        }
        </script>
        `,
      );
      writeFile(
        tmp,
        'src/router/index.js',
        `
        const Subscribe = wrapper(() => import('@/views/subscribe'))
        export default [
          { path: '/subscribe/home', component: Subscribe },
          { path: '/subscribe/landing', component: Subscribe },
        ]
        `,
      );

      const topo = extractProjectTopology(tmp);

      assert.equal(topo.routes['/subscribe/home'].filePath, 'src/views/subscribe/index.vue');
      assert.equal(topo.routes['/subscribe'], undefined);
      assert.ok(topo.routes['/subscribe/home'].semanticKeywords.includes('新股申购'));
      assert.equal(topo.routes['/subscribe/home'].transitions[0].targetRoute, '/subscribe/my');
      assert.equal(topo.routes['/subscribe/landing'].filePath, 'src/views/subscribe/index.vue');
      assert.ok(topo.routes['/subscribe/landing'].semanticKeywords.includes('新股申购'));
      assert.ok(logs.includes('[IDT] Vue Router: records=2 mapped=2 unresolved=0'));

      const semanticIndex = JSON.parse(
        fs.readFileSync(path.join(tmp, '.idt', 'semantic-index.json'), 'utf8'),
      );
      assert.ok(
        semanticIndex.entries.some(
          (entry: { keyword: string; route: string }) =>
            entry.keyword === '新股申购' && entry.route === '/subscribe/landing',
        ),
      );

      writeFile(
        tmp,
        'src/router/index.js',
        `
        const Subscribe = wrapper(() => import('@/views/subscribe'))
        export default [{ path: '/subscribe/start', component: Subscribe }]
        `,
      );
      const updated = extractProjectTopology(tmp);
      assert.notEqual(updated.sourceDigest, topo.sourceDigest);
      assert.equal(updated.routes['/subscribe/start'].filePath, 'src/views/subscribe/index.vue');
    } finally {
      console.log = originalLog;
      removeTempDir(tmp);
    }
  });

  it('keeps the first page when Vue Router maps two components to the same route', () => {
    const tmp = createTempDir();
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    try {
      writeFile(
        tmp,
        'idt.config.ts',
        `export default {
          pageGlobs: ['src/views/**/*.vue'],
          routerGlobs: ['src/router/**/*.js'],
          localeFiles: [],
        };`,
      );
      writeFile(tmp, 'src/views/a/index.vue', '<template><div>页面甲</div></template>');
      writeFile(tmp, 'src/views/b/index.vue', '<template><div>页面乙</div></template>');
      writeFile(
        tmp,
        'src/router/index.js',
        `
        const A = () => import('@/views/a')
        const B = () => import('@/views/b')
        export default [
          { path: '/same', component: A },
          { path: '/same', component: B },
        ]
        `,
      );

      const topo = extractProjectTopology(tmp);

      assert.equal(topo.routes['/same'].filePath, 'src/views/a/index.vue');
      assert.ok(logs.some((line) => line.includes('duplicate route /same')));
    } finally {
      console.log = originalLog;
      removeTempDir(tmp);
    }
  });
  it('writes the interactable element inventory onto each route node', () => {
    const tmp = createTempDir();
    try {
      writeFile(
        tmp,
        'idt.config.ts',
        `export default { pageGlobs: ['src/views/**/*.vue'], localeFiles: [] };
`,
      );
      writeFile(
        tmp,
        'src/views/buy/index.vue',
        `
        <template>
          <div>
            <h2>融资买入</h2>
            <van-field label="股票代码" />
            <input type="text" placeholder="买入数量" />
            <van-button>买入</van-button>
            <van-button>{{ dynamicLabel }}</van-button>
            <p>仅供参考</p>
          </div>
        </template>
        `,
      );

      const topo = extractProjectTopology(tmp);
      const node = topo.routes['/buy'];

      assert.deepEqual(node.elements, [
        { role: 'heading', name: '融资买入' },
        { role: 'textbox', name: '股票代码' },
        { role: 'textbox', name: '买入数量' },
        { role: 'button', name: '买入' },
        { role: 'button', dynamic: true, tag: 'van-button' },
      ]);
      assert.equal(ProjectTopologySchema.safeParse(topo).success, true);
    } finally {
      removeTempDir(tmp);
    }
  });

  it('accepts a topology written before the elements field existed', () => {
    const legacy = {
      version: '1.0.0',
      generatedAt: '2026-10-01T00:00:00.000Z',
      sourceDigest: 'a'.repeat(64),
      routes: {
        '/buy': {
          path: '/buy',
          filePath: 'src/views/buy/index.vue',
          title: 'index',
          semanticKeywords: ['买入'],
          dynamicParams: [],
          transitions: [],
        },
      },
    };
    const parsed = ProjectTopologySchema.safeParse(legacy);
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.deepEqual(parsed.data.routes['/buy'].elements, []);
    }
  });
  it('does not invent file-path routes once the router resolved every record', () => {
    const tmp = createTempDir();
    try {
      writeFile(
        tmp,
        'idt.config.ts',
        `export default {
          pageGlobs: ['src/views/**/*.vue', 'src/credit/views/**/*.vue'],
          routerGlobs: ['src/router/**/*.js'],
          localeFiles: [],
        };
`,
      );
      writeFile(tmp, 'src/views/transfer/index.vue', '<template><div>转账</div></template>');
      // 这个文件没有被任何路由引用。文件路径兜底会剥掉 credit/ 前缀，
      // 造出一条和真路由同名的 /transfer，撞车后真路由还可能被挤掉。
      writeFile(tmp, 'src/credit/views/transfer/index.vue', '<template><div>信用转账</div></template>');
      writeFile(
        tmp,
        'src/router/index.js',
        `const Transfer = () => import('@/views/transfer')
         export default [{ path: '/transfer', component: Transfer }]
`,
      );

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (line: unknown) => logs.push(String(line));
      let topo: ReturnType<typeof extractProjectTopology>;
      try {
        topo = extractProjectTopology(tmp);
      } finally {
        console.log = originalLog;
      }

      assert.equal(topo.routes['/transfer'].filePath, 'src/views/transfer/index.vue');
      assert.equal(
        logs.some((line) => line.includes('duplicate route')),
        false,
        `不该再出现 duplicate 警告：${logs.join(' | ')}`,
      );
      assert.ok(
        logs.some((line) => line.includes('src/credit/views/transfer/index.vue')),
        '被跳过的未挂载文件要有迹可循',
      );
    } finally {
      removeTempDir(tmp);
    }
  });

  it('still falls back to file paths when the project has no router at all', () => {
    const tmp = createTempDir();
    try {
      writeFile(
        tmp,
        'idt.config.ts',
        `export default { pageGlobs: ['src/views/**/*.vue'], localeFiles: [] };
`,
      );
      writeFile(tmp, 'src/views/about/index.vue', '<template><div>关于我们</div></template>');

      const topo = extractProjectTopology(tmp);
      assert.ok(topo.routes['/about'], '没有 routerGlobs 时必须保留文件路径兜底');
    } finally {
      removeTempDir(tmp);
    }
  });
  it('attributes child component navigation to the page', () => {
    const tmp = createTempDir();
    try {
      writeFile(
        tmp,
        'idt.config.ts',
        `export default { pageGlobs: ['src/views/**/*.vue'], localeFiles: [] };
`,
      );
      writeFile(
        tmp,
        'src/views/home/index.vue',
        `<template><Card /></template>
         <script>import Card from './components/Card.vue';</script>`,
      );
      writeFile(
        tmp,
        'src/views/home/components/Card.vue',
        `<template><div @click="go">去明细</div></template>
         <script>export default { methods: { go() { this.$router.push('/detail'); } } };</script>`,
      );
      writeFile(tmp, 'src/views/detail/index.vue', '<template><div>明细</div></template>');

      const topo = extractProjectTopology(tmp);
      const targets = topo.routes['/home'].transitions.map((t) => t.targetRoute);
      assert.deepEqual(targets, ['/detail']);
      assert.equal(topo.routes['/home'].transitions[0].triggerElementText, '去明细');
    } finally {
      removeTempDir(tmp);
    }
  });

  it('can be turned off, restoring the page-only behaviour', () => {
    const tmp = createTempDir();
    try {
      writeFile(
        tmp,
        'idt.config.ts',
        `export default { pageGlobs: ['src/views/**/*.vue'], localeFiles: [] };
`,
      );
      writeFile(
        tmp,
        'src/views/home/index.vue',
        `<script>import Card from './components/Card.vue';</script>`,
      );
      writeFile(
        tmp,
        'src/views/home/components/Card.vue',
        `<script>export default { methods: { go() { this.$router.push('/detail'); } } };</script>`,
      );
      writeFile(tmp, 'src/views/detail/index.vue', '<template><div>明细</div></template>');

      const topo = extractProjectTopology(tmp, { componentNavDepth: 0 });
      assert.deepEqual(topo.routes['/home'].transitions, []);
    } finally {
      removeTempDir(tmp);
    }
  });

  it('does not duplicate a target the page already navigates to itself', () => {
    const tmp = createTempDir();
    try {
      writeFile(
        tmp,
        'idt.config.ts',
        `export default { pageGlobs: ['src/views/**/*.vue'], localeFiles: [] };
`,
      );
      writeFile(
        tmp,
        'src/views/home/index.vue',
        `<script>import Card from './components/Card.vue';
         export default { methods: { go() { this.$router.push('/detail'); } } };</script>`,
      );
      writeFile(
        tmp,
        'src/views/home/components/Card.vue',
        `<script>export default { methods: { go() { this.$router.push('/detail'); } } };</script>`,
      );
      writeFile(tmp, 'src/views/detail/index.vue', '<template><div>明细</div></template>');

      const topo = extractProjectTopology(tmp);
      assert.equal(
        topo.routes['/home'].transitions.filter((t) => t.targetRoute === '/detail').length,
        1,
      );
    } finally {
      removeTempDir(tmp);
    }
  });
});
