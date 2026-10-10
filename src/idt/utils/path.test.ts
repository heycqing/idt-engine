import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  toPosixPath,
  toRoutePattern,
  segmentsMatch,
  extractDynamicParams,
} from './path.js';

describe('path utils', () => {
  const projectRoot = path.resolve('/workspace/project');

  it('toRoutePattern handles various route conventions', () => {
    // 1. src/pages/cart/index.tsx -> /cart
    assert.equal(
      toRoutePattern(projectRoot, path.join(projectRoot, 'src/pages/cart/index.tsx')),
      '/cart'
    );

    // 2. src/pages/index.tsx -> /
    assert.equal(
      toRoutePattern(projectRoot, path.join(projectRoot, 'src/pages/index.tsx')),
      '/'
    );

    // 3. src/app/(shop)/cart/page.tsx -> /cart
    assert.equal(
      toRoutePattern(projectRoot, path.join(projectRoot, 'src/app/(shop)/cart/page.tsx')),
      '/cart'
    );

    // 4. src/app/page.tsx -> /
    assert.equal(
      toRoutePattern(projectRoot, path.join(projectRoot, 'src/app/page.tsx')),
      '/'
    );

    // 5. src/app/goods/[id]/page.tsx -> /goods/:id
    assert.equal(
      toRoutePattern(projectRoot, path.join(projectRoot, 'src/app/goods/[id]/page.tsx')),
      '/goods/:id'
    );

    // 6. src/app/docs/[...slug]/page.tsx -> null
    assert.equal(
      toRoutePattern(projectRoot, path.join(projectRoot, 'src/app/docs/[...slug]/page.tsx')),
      null
    );

    // 7. src/app/mypage.tsx -> null
    assert.equal(
      toRoutePattern(projectRoot, path.join(projectRoot, 'src/app/mypage.tsx')),
      null
    );

    // 8. src/pages/components/Button.tsx -> null
    assert.equal(
      toRoutePattern(projectRoot, path.join(projectRoot, 'src/pages/components/Button.tsx')),
      null
    );

    // 9. src/components/Button.tsx -> null
    assert.equal(
      toRoutePattern(projectRoot, path.join(projectRoot, 'src/components/Button.tsx')),
      null
    );
  });

  it('toPosixPath replaces separators with /', () => {
    assert.equal(toPosixPath('src\\pages\\index.tsx'), 'src/pages/index.tsx');
    assert.equal(toPosixPath('src/pages/index.tsx'), 'src/pages/index.tsx');
  });

  it('segmentsMatch correctly matches patterns against concrete routes', () => {
    assert.equal(segmentsMatch('/goods/:id', '/goods/1'), true);
    assert.equal(segmentsMatch('/goods/:id', '/goods'), false);
    assert.equal(segmentsMatch('/goods/:id', '/cart/1'), false);
    assert.equal(segmentsMatch('/cart', '/cart'), true);
  });

  it('extractDynamicParams extracts parameter names', () => {
    assert.deepEqual(extractDynamicParams('/goods/:id'), ['id']);
    assert.deepEqual(extractDynamicParams('/goods/:id/reviews/:reviewId'), ['id', 'reviewId']);
    assert.deepEqual(extractDynamicParams('/cart'), []);
  });
});
