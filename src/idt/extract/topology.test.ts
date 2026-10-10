import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { extractProjectTopology, readTopology } from './topology.js';
import {
  ProjectTopologySchema,
  SemanticIndexSchema,
} from '../schemas/topology.schema.js';

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
});
