import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { StateTransitionIR } from '../../../src/idt/core/ir-schema.js';
import { emitSpec } from '../../../src/idt/core/emitter.js';
import { heal, firstFailure } from '../../../src/idt/core/healer.js';

function setupFixture(dir: string) {
  const ir: StateTransitionIR = {
    flowId: 'flow_1122334455',
    intent: 'checkout order',
    oracle: 'regression-lock',
    description: 'checkout flow',
    initialRoute: '/checkout',
    setup: { notes: [] },
    unresolved: [],
    stages: [
      {
        stageIndex: 0,
        stageName: 'checkout stage',
        routePattern: '/checkout',
        actions: [
          {
            actionType: 'CLICK',
            targetRole: 'button',
            targetName: '确认去结算订单',
            timeoutMs: 5000,
            triggersRequest: false,
          },
        ],
        invariants: {
          network: [],
          routeGuard: {
            targetUrlPattern: '^/order/success$',
          },
        },
      },
    ],
  };

  const irPath = path.join(dir, 'flow_1122334455.ir.json');
  const specPath = path.join(dir, 'flow_1122334455.spec.ts');
  const irContent = JSON.stringify(ir, null, 2) + '\n';
  const specContent = emitSpec(ir);

  fs.writeFileSync(irPath, irContent, 'utf8');
  fs.writeFileSync(specPath, specContent, 'utf8');

  const lines = specContent.split(/\r?\n/);
  const failureLine =
    lines.findIndex((l) =>
      l.includes('getByRole("button", { name: "确认去结算订单", exact: true })'),
    ) + 1;

  return { ir, irPath, specPath, irContent, specContent, failureLine };
}

function makeTimeoutReport(
  line: number,
  role = 'button',
  name = '确认去结算订单',
) {
  return {
    suites: [
      {
        specs: [
          {
            tests: [
              {
                results: [
                  {
                    status: 'timedOut',
                    errors: [
                      {
                        message: `Timeout 5000ms exceeded while waiting for getByRole("${role}", { name: "${name}" })`,
                        location: { line },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('healer', () => {
  it('Requirement 1: first runSpec exits with code 0; replay calls is 0, files unchanged, heal returns 0', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idt-healer-'));
    try {
      const fixture = setupFixture(tempDir);
      let replayCalls = 0;
      let runSpecCalls = 0;

      const mockRunSpec = async () => {
        runSpecCalls++;
        return { exitCode: 0, report: null };
      };

      const mockReplay = async () => {
        replayCalls++;
        return '';
      };

      const result = await heal({
        projectRoot: tempDir,
        specPath: fixture.specPath,
        runSpec: mockRunSpec,
        replay: mockReplay,
      });

      assert.equal(result.exitCode, 0);
      assert.equal(runSpecCalls, 1);
      assert.equal(replayCalls, 0);
      assert.equal(fs.readFileSync(fixture.irPath, 'utf8'), fixture.irContent);
      assert.equal(
        fs.readFileSync(fixture.specPath, 'utf8'),
        fixture.specContent,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('Requirement 2: timedOut failure healed to candidate in snapshot; runSpec called twice, replay called once', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idt-healer-'));
    try {
      const fixture = setupFixture(tempDir);
      let replayCalls = 0;
      let runSpecCalls = 0;
      let secondRunSpecObservedContent = '';

      const report = makeTimeoutReport(fixture.failureLine);

      const mockRunSpec = async (sp: string) => {
        runSpecCalls++;
        if (runSpecCalls === 1) {
          return { exitCode: 1, report };
        }
        secondRunSpecObservedContent = fs.readFileSync(sp, 'utf8');
        return { exitCode: 0, report: null };
      };

      const mockReplay = async () => {
        replayCalls++;
        return '- button "确认去结账订单"';
      };

      const result = await heal({
        projectRoot: tempDir,
        specPath: fixture.specPath,
        runSpec: mockRunSpec,
        replay: mockReplay,
      });

      assert.equal(result.exitCode, 0);
      assert.equal(runSpecCalls, 2);
      assert.equal(replayCalls, 1);
      assert.ok(secondRunSpecObservedContent.includes('确认去结账订单'));
      assert.ok(secondRunSpecObservedContent.includes('.click('));

      const updatedIr = JSON.parse(fs.readFileSync(fixture.irPath, 'utf8'));
      assert.equal(
        updatedIr.stages[0].actions[0].targetName,
        '确认去结账订单',
      );
      assert.equal(
        fs.readFileSync(fixture.specPath, 'utf8'),
        emitSpec(updatedIr),
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('Requirement 3: snapshot contains both 确认去结账订单 and 确认去结算定单 -> returns 2, files unchanged, runSpec called once', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idt-healer-'));
    try {
      const fixture = setupFixture(tempDir);
      let replayCalls = 0;
      let runSpecCalls = 0;

      const report = makeTimeoutReport(fixture.failureLine);

      const mockRunSpec = async () => {
        runSpecCalls++;
        return { exitCode: 1, report };
      };

      const mockReplay = async () => {
        replayCalls++;
        return '- button "确认去结账订单"\n- button "确认去结算定单"';
      };

      const result = await heal({
        projectRoot: tempDir,
        specPath: fixture.specPath,
        runSpec: mockRunSpec,
        replay: mockReplay,
      });

      assert.equal(result.exitCode, 2);
      assert.equal(runSpecCalls, 1);
      assert.equal(replayCalls, 1);
      assert.equal(fs.readFileSync(fixture.irPath, 'utf8'), fixture.irContent);
      assert.equal(
        fs.readFileSync(fixture.specPath, 'utf8'),
        fixture.specContent,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('Requirement 4: snapshot has same role but insufficient similarity (完全不同) -> returns 2, files unchanged', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idt-healer-'));
    try {
      const fixture = setupFixture(tempDir);
      let runSpecCalls = 0;

      const report = makeTimeoutReport(fixture.failureLine);
      const mockRunSpec = async () => {
        runSpecCalls++;
        return { exitCode: 1, report };
      };
      const mockReplay = async () => {
        return '- button "完全不同"';
      };

      const result = await heal({
        projectRoot: tempDir,
        specPath: fixture.specPath,
        runSpec: mockRunSpec,
        replay: mockReplay,
      });

      assert.equal(result.exitCode, 2);
      assert.equal(runSpecCalls, 1);
      assert.equal(fs.readFileSync(fixture.irPath, 'utf8'), fixture.irContent);
      assert.equal(
        fs.readFileSync(fixture.specPath, 'utf8'),
        fixture.specContent,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('Requirement 5: candidate role in snapshot is link while failure action is button -> returns 2, files unchanged', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idt-healer-'));
    try {
      const fixture = setupFixture(tempDir);
      const report = makeTimeoutReport(fixture.failureLine);

      const mockRunSpec = async () => {
        return { exitCode: 1, report };
      };
      const mockReplay = async () => {
        return '- link "确认去结账订单"';
      };

      const result = await heal({
        projectRoot: tempDir,
        specPath: fixture.specPath,
        runSpec: mockRunSpec,
        replay: mockReplay,
      });

      assert.equal(result.exitCode, 2);
      assert.equal(fs.readFileSync(fixture.irPath, 'utf8'), fixture.irContent);
      assert.equal(
        fs.readFileSync(fixture.specPath, 'utf8'),
        fixture.specContent,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('Requirement 6: second runSpec returns 1 -> heal returns 1 and restores memory bytes, replay called once', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idt-healer-'));
    try {
      const fixture = setupFixture(tempDir);
      let runSpecCalls = 0;
      let replayCalls = 0;

      const report = makeTimeoutReport(fixture.failureLine);

      const mockRunSpec = async () => {
        runSpecCalls++;
        return { exitCode: 1, report };
      };

      const mockReplay = async () => {
        replayCalls++;
        return '- button "确认去结账订单"';
      };

      const result = await heal({
        projectRoot: tempDir,
        specPath: fixture.specPath,
        runSpec: mockRunSpec,
        replay: mockReplay,
      });

      assert.equal(result.exitCode, 1);
      assert.equal(runSpecCalls, 2);
      assert.equal(replayCalls, 1);
      assert.equal(fs.readFileSync(fixture.irPath, 'utf8'), fixture.irContent);
      assert.equal(
        fs.readFileSync(fixture.specPath, 'utf8'),
        fixture.specContent,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('Requirement 7: failure message is expect(received).toBe(expected) without Timeout -> returns 2, replay not called', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idt-healer-'));
    try {
      const fixture = setupFixture(tempDir);
      let replayCalls = 0;

      const report = {
        suites: [
          {
            specs: [
              {
                tests: [
                  {
                    results: [
                      {
                        status: 'failed',
                        errors: [
                          {
                            message:
                              'expect(received).toBe(expected)\nExpected: 200\nReceived: 500',
                            location: { line: fixture.failureLine },
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      const mockRunSpec = async () => {
        return { exitCode: 1, report };
      };
      const mockReplay = async () => {
        replayCalls++;
        return '- button "确认去结账订单"';
      };

      const result = await heal({
        projectRoot: tempDir,
        specPath: fixture.specPath,
        runSpec: mockRunSpec,
        replay: mockReplay,
      });

      assert.equal(result.exitCode, 2);
      assert.equal(replayCalls, 0);
      assert.equal(fs.readFileSync(fixture.irPath, 'utf8'), fixture.irContent);
      assert.equal(
        fs.readFileSync(fixture.specPath, 'utf8'),
        fixture.specContent,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('Requirement 8: missing matching .ir.json in same directory -> returns 2', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idt-healer-'));
    try {
      const fixture = setupFixture(tempDir);
      fs.unlinkSync(fixture.irPath);

      const result = await heal({
        projectRoot: tempDir,
        specPath: fixture.specPath,
      });

      assert.equal(result.exitCode, 2);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('Requirement 9: spawnSync scripts/idt/cli.ts heal <nonexistent spec> with OPENAI_API_KEY="" exits with 2 without browser', () => {
    const cliPath = path.resolve('scripts/idt/cli.ts');
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', cliPath, 'heal', 'nonexistent.spec.ts'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENAI_API_KEY: '',
          FORCE_COLOR: '0',
        },
        encoding: 'utf8',
      },
    );

    assert.equal(child.status, 2);
    assert.ok(
      child.stderr.includes('Heal failed with exit code 2') ||
        child.stderr.includes('exit code 2') ||
        child.stderr.length > 0,
    );
  });

  it('firstFailure prefers the spec at this level over a nested suite', () => {
    const report = {
      suites: [
        {
          specs: [
            {
              tests: [
                {
                  results: [
                    {
                      status: 'timedOut',
                      errors: [
                        {
                          message: 'Timeout 5000ms exceeded',
                          location: { file: 'a.spec.ts', line: 4, column: 1 },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
          suites: [
            {
              specs: [
                {
                  tests: [
                    {
                      results: [
                        {
                          status: 'failed',
                          errors: [
                            {
                              message: 'Timeout later',
                              location: { file: 'a.spec.ts', line: 99, column: 1 },
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    assert.equal(firstFailure(report)?.line, 4);
  });
});
