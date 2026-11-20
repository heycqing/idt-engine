import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { resolvePlaywrightRuntime } from '../../../src/idt/core/playwright-runtime.js';

describe('Playwright runtime resolution', () => {
  it('uses the Playwright peer resolved by Midscene for the current host project', () => {
    const projectRoot = path.resolve('..');
    const hostRequire = createRequire(path.join(projectRoot, 'package.json'));
    const midsceneEntry = hostRequire.resolve('@midscene/web/playwright');
    const midscenePeer = createRequire(midsceneEntry).resolve('playwright');
    const runtime = resolvePlaywrightRuntime(projectRoot);
    const hostPeer = hostRequire.resolve('playwright');

    assert.equal(hostPeer, midscenePeer);
    assert.equal(runtime.chromium, createRequire(midscenePeer)('playwright').chromium);
  });
});
