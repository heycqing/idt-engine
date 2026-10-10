import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateIr } from './validate-ir.js';
import type { StateTransitionIR } from './ir-schema.js';

function createTempDir(prefix = 'idt-val-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

function getBaseValidIr(): StateTransitionIR {
  return {
    flowId: 'flow_0123456789',
    intent: '测试用例',
    oracle: 'regression-lock',
    description: '基本合法 IR',
    initialRoute: '/cart',
    setup: {
      notes: [],
    },
    unresolved: [],
    stages: [
      {
        stageIndex: 0,
        stageName: '购物车',
        routePattern: '/cart',
        actions: [
          {
            actionType: 'CLICK',
            targetRole: 'button',
            targetName: '去结算',
            timeoutMs: 5000,
            triggersRequest: true,
          },
        ],
        invariants: {
          network: [
            {
              method: 'POST',
              urlPattern: '/api/checkout',
              expectedStatus: 200,
              responseType: 'json',
            },
          ],
        },
      },
    ],
  };
}

describe('validateIr', () => {
  it('Requirement 10: Legal IR with non-empty unresolved throws exitCode 2', () => {
    const tmp = createTempDir();
    try {
      const ir = getBaseValidIr();
      ir.unresolved = ['需要登录'];

      assert.throws(
        () =>
          validateIr(ir, {
            projectRoot: tmp,
            routePath: ['/cart'],
            mode: 'gen',
          }),
        (err: any) => {
          assert.equal(err.exitCode, 2);
          assert.ok(err.message.includes('需要登录'));
          return true;
        }
      );
    } finally {
      removeTempDir(tmp);
    }
  });

  it('Requirement 11: Stage with CLICK action but empty network and no routeGuard throws exitCode 2', () => {
    const tmp = createTempDir();
    try {
      const ir = getBaseValidIr();
      ir.stages[0].invariants = {
        network: [],
        routeGuard: undefined,
      };

      assert.throws(
        () =>
          validateIr(ir, {
            projectRoot: tmp,
            routePath: ['/cart'],
            mode: 'gen',
          }),
        (err: any) => {
          assert.equal(err.exitCode, 2);
          return true;
        }
      );
    } finally {
      removeTempDir(tmp);
    }
  });

  it('Requirement 12: Prose case contains "请先登录" but neither login route nor storageStatePath exists -> exitCode 2', () => {
    const tmp = createTempDir();
    try {
      const ir = getBaseValidIr();

      assert.throws(
        () =>
          validateIr(ir, {
            projectRoot: tmp,
            routePath: ['/cart'],
            proseCase: '操作步骤：请先登录后再进行结账。',
            mode: 'gen',
          }),
        (err: any) => {
          assert.equal(err.exitCode, 2);
          assert.ok(
            err.message.includes('缺少登录态'),
            `Expected message to contain 缺少登录态, got: ${err.message}`
          );
          return true;
        }
      );
    } finally {
      removeTempDir(tmp);
    }
  });

  it('Requirement 13: storageStatePath pointing outside throws exitCode 2; existing inside path passes', () => {
    const tmp = createTempDir();
    try {
      const outsideIr = getBaseValidIr();
      outsideIr.setup.storageStatePath = '../outside.json';

      assert.throws(
        () =>
          validateIr(outsideIr, {
            projectRoot: tmp,
            routePath: ['/cart'],
            mode: 'gen',
          }),
        (err: any) => {
          assert.equal(err.exitCode, 2);
          return true;
        }
      );

      // Existing file inside projectRoot passes
      const insideFile = path.join(tmp, 'state.json');
      fs.writeFileSync(insideFile, '{}', 'utf8');

      const insideIr = getBaseValidIr();
      insideIr.setup.storageStatePath = 'state.json';

      assert.doesNotThrow(() =>
        validateIr(insideIr, {
          projectRoot: tmp,
          routePath: ['/cart'],
          mode: 'gen',
        })
      );
    } finally {
      removeTempDir(tmp);
    }
  });

  it('Requirement 16: emit mode with mismatching fileStem and flowId throws exitCode 2', () => {
    const tmp = createTempDir();
    try {
      const ir = getBaseValidIr();
      ir.flowId = 'flow_0123456789';

      assert.throws(
        () =>
          validateIr(ir, {
            projectRoot: tmp,
            routePath: ['/cart'],
            mode: 'emit',
            fileStem: 'flow_9999999999',
          }),
        (err: any) => {
          assert.equal(err.exitCode, 2);
          return true;
        }
      );

      // Matching fileStem passes
      assert.doesNotThrow(() =>
        validateIr(ir, {
          projectRoot: tmp,
          routePath: ['/cart'],
          mode: 'emit',
          fileStem: 'flow_0123456789',
        })
      );
    } finally {
      removeTempDir(tmp);
    }
  });

  it('Dynamic route parameter ":" throws exitCode 2 with "具体参数"', () => {
    const tmp = createTempDir();
    try {
      const ir = getBaseValidIr();
      ir.initialRoute = '/cart/:id';

      assert.throws(
        () =>
          validateIr(ir, {
            projectRoot: tmp,
            routePath: ['/cart/:id'],
            mode: 'gen',
          }),
        (err: any) => {
          assert.equal(err.exitCode, 2);
          assert.ok(
            err.message.includes('具体参数'),
            `Expected message to contain 具体参数, got: ${err.message}`
          );
          return true;
        }
      );
    } finally {
      removeTempDir(tmp);
    }
  });

  it('assertResponseFields key with invalid characters throws exitCode 2', () => {
    const tmp = createTempDir();
    try {
      const ir = getBaseValidIr();
      ir.stages[0].invariants.network[0].assertResponseFields = {
        'items[0].id': 123,
      };

      assert.throws(
        () =>
          validateIr(ir, {
            projectRoot: tmp,
            routePath: ['/cart'],
            mode: 'gen',
          }),
        (err: any) => {
          assert.equal(err.exitCode, 2);
          return true;
        }
      );
    } finally {
      removeTempDir(tmp);
    }
  });
});
