import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probe, type ProbeTarget } from '../../../src/idt/core/prober.js';
import type { StateTransitionIR } from '../../../src/idt/core/ir-schema.js';

function makeIr(): StateTransitionIR {
  return {
    flowId: 'flow_0123456789',
    intent: '提交表单',
    oracle: 'regression-lock',
    description: '提交后显示结果',
    initialRoute: '/form',
    setup: { notes: [] },
    unresolved: [],
    stages: [
      {
        stageIndex: 0,
        stageName: '提交',
        routePattern: '/form',
        actions: [
          {
            actionType: 'CLICK',
            targetRole: 'button',
            targetName: '提交',
            timeoutMs: 2000,
            triggersRequest: true,
          },
        ],
        invariants: {
          network: [
            {
              method: 'POST',
              urlPattern: '/api/submit',
              expectedStatus: 200,
              responseType: 'json',
            },
          ],
        },
      },
    ],
  };
}

function fixture(ir: unknown = makeIr()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idt-probe-'));
  const irPath = path.join(root, 'flow_0123456789.ir.json');
  const content = JSON.stringify(ir, null, 2) + '\n';
  fs.writeFileSync(irPath, content, 'utf8');
  return {
    root,
    irPath,
    content,
    specPath: path.join(root, 'flow_0123456789.spec.ts'),
  };
}

describe('probe', () => {
  it('writes the unique appeared element to the IR and re-emits the spec', async () => {
    const item = fixture();
    try {
      const result = await probe({
        projectRoot: item.root,
        irPath: item.irPath,
        replay: async () => ({
          before: '- button "提交"',
          after: '- button "提交"\n- dialog "提交成功"',
        }),
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.written, true);
      assert.deepEqual(result.delta, {
        appearedRole: 'dialog',
        appearedName: '提交成功',
      });
      const written = JSON.parse(fs.readFileSync(item.irPath, 'utf8'));
      assert.deepEqual(written.stages[0].invariants.domDelta, result.delta);
      assert.match(fs.readFileSync(item.specPath, 'utf8'), /提交成功/);
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  // 真实 aria 快照里 banner、list、region 这类 role 很常见。它们不在
  // AppearedRoleSchema 里，断言写不出来——要给人话，不要吐一串 zod 转储。
  it('refuses an unsupported appeared role with a readable reason', async () => {
    const item = fixture();
    try {
      const result = await probe({
        projectRoot: item.root,
        irPath: item.irPath,
        replay: async () => ({ before: '', after: '- banner "顶部"' }),
      });

      assert.equal(result.exitCode, 2);
      assert.equal(result.written, undefined);
      assert.match(result.reason ?? '', /banner/);
      assert.doesNotMatch(result.reason ?? '', /zod|ZodError|invalid_/i);
      assert.equal(fs.readFileSync(item.irPath, 'utf8'), item.content, 'IR 不该被改');
      assert.equal(fs.existsSync(item.specPath), false, 'spec 不该被写出');
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it('returns multiple candidates without changing either file', async () => {
    const item = fixture();
    fs.writeFileSync(item.specPath, 'ORIGINAL SPEC', 'utf8');
    try {
      const result = await probe({
        projectRoot: item.root,
        irPath: item.irPath,
        replay: async () => ({
          before: '',
          after: '- dialog "确认"\n- button "关闭"',
        }),
      });

      assert.equal(result.exitCode, 2);
      assert.deepEqual(result.candidates, [
        { role: 'dialog', name: '确认' },
        { role: 'button', name: '关闭' },
      ]);
      assert.equal(fs.readFileSync(item.irPath, 'utf8'), item.content);
      assert.equal(fs.readFileSync(item.specPath, 'utf8'), 'ORIGINAL SPEC');
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it('writes the second candidate when pick is 2', async () => {
    const item = fixture();
    try {
      const result = await probe({
        projectRoot: item.root,
        irPath: item.irPath,
        pick: 2,
        replay: async () => ({
          before: '',
          after: '- text "动态结果"\n- button "确认"',
        }),
      });

      assert.equal(result.exitCode, 0);
      assert.deepEqual(result.delta, {
        appearedRole: 'button',
        appearedName: '确认',
      });
      const written = JSON.parse(fs.readFileSync(item.irPath, 'utf8'));
      assert.deepEqual(written.stages[0].invariants.domDelta, result.delta);
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it('writes the first candidate when pick is 1', async () => {
    const item = fixture();
    try {
      const result = await probe({
        projectRoot: item.root,
        irPath: item.irPath,
        pick: 1,
        replay: async () => ({
          before: '',
          after: '- dialog "先出现"\n- button "后出现"',
        }),
      });

      assert.equal(result.exitCode, 0);
      assert.deepEqual(result.delta, {
        appearedRole: 'dialog',
        appearedName: '先出现',
      });
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it('pick 1 with one candidate matches the result without pick', async () => {
    const pickedItem = fixture();
    const defaultItem = fixture();
    const replay = async () => ({ before: '', after: '- dialog "完成"' });
    try {
      const picked = await probe({
        projectRoot: pickedItem.root,
        irPath: pickedItem.irPath,
        pick: 1,
        replay,
      });
      const defaultResult = await probe({
        projectRoot: defaultItem.root,
        irPath: defaultItem.irPath,
        replay,
      });

      assert.equal(picked.exitCode, 0);
      assert.deepEqual(picked.delta, defaultResult.delta);
      assert.equal(
        fs.readFileSync(pickedItem.irPath, 'utf8'),
        fs.readFileSync(defaultItem.irPath, 'utf8'),
      );
      assert.equal(
        fs.readFileSync(pickedItem.specPath, 'utf8'),
        fs.readFileSync(defaultItem.specPath, 'utf8'),
      );
    } finally {
      fs.rmSync(pickedItem.root, { recursive: true, force: true });
      fs.rmSync(defaultItem.root, { recursive: true, force: true });
    }
  });

  it('rejects a pick beyond the candidate count without changing files', async () => {
    const item = fixture();
    try {
      const result = await probe({
        projectRoot: item.root,
        irPath: item.irPath,
        pick: 3,
        replay: async () => ({
          before: '',
          after: '- dialog "确认"\n- button "关闭"',
        }),
      });

      assert.equal(result.exitCode, 2);
      assert.match(result.reason ?? '', /2/);
      assert.match(result.reason ?? '', /3/);
      assert.equal(fs.readFileSync(item.irPath, 'utf8'), item.content);
      assert.equal(fs.existsSync(item.specPath), false);
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  for (const invalidPick of [0, -1, 1.5]) {
    it(`rejects invalid pick ${invalidPick} before replay`, async () => {
      const item = fixture();
      let replayCalls = 0;
      try {
        const result = await probe({
          projectRoot: item.root,
          irPath: item.irPath,
          pick: invalidPick,
          replay: async () => {
            replayCalls += 1;
            throw new Error('must not replay');
          },
        });

        assert.equal(result.exitCode, 2);
        assert.match(result.reason ?? '', /从 1 开始/);
        assert.equal(replayCalls, 0);
        assert.equal(fs.readFileSync(item.irPath, 'utf8'), item.content);
        assert.equal(fs.existsSync(item.specPath), false);
      } finally {
        fs.rmSync(item.root, { recursive: true, force: true });
      }
    });
  }

  it('pick 1 reports no observable DOM effect without changing files', async () => {
    const item = fixture();
    try {
      const result = await probe({
        projectRoot: item.root,
        irPath: item.irPath,
        pick: 1,
        replay: async () => ({ before: '- button "提交"', after: '- button "提交"' }),
      });

      assert.equal(result.exitCode, 2);
      assert.match(result.reason ?? '', /没有可观察/);
      assert.equal(fs.readFileSync(item.irPath, 'utf8'), item.content);
      assert.equal(fs.existsSync(item.specPath), false);
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it('rejects an unsupported picked role with the existing readable reason', async () => {
    const item = fixture();
    try {
      const result = await probe({
        projectRoot: item.root,
        irPath: item.irPath,
        pick: 2,
        replay: async () => ({
          before: '',
          after: '- button "确认"\n- banner "顶部"',
        }),
      });

      assert.equal(result.exitCode, 2);
      assert.match(result.reason ?? '', /banner/);
      assert.doesNotMatch(result.reason ?? '', /zod|ZodError|invalid_/i);
      assert.equal(fs.readFileSync(item.irPath, 'utf8'), item.content);
      assert.equal(fs.existsSync(item.specPath), false);
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it('reports no observable DOM effect without changing files', async () => {
    const item = fixture();
    try {
      const result = await probe({
        projectRoot: item.root,
        irPath: item.irPath,
        replay: async () => ({ before: '- button "提交"', after: '- button "提交"' }),
      });

      assert.equal(result.exitCode, 2);
      assert.match(result.reason ?? '', /没有可观察/);
      assert.equal(fs.readFileSync(item.irPath, 'utf8'), item.content);
      assert.equal(fs.existsSync(item.specPath), false);
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it('returns exit code 2 instead of throwing for schema-invalid IR', async () => {
    const item = fixture({ flowId: 'invalid' });
    try {
      const result = await probe({
        projectRoot: item.root,
        irPath: item.irPath,
        replay: async () => {
          throw new Error('must not replay');
        },
      });

      assert.equal(result.exitCode, 2);
      assert.match(result.reason ?? '', /schema/i);
      assert.equal(fs.readFileSync(item.irPath, 'utf8'), item.content);
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it('skips a stage that already has domDelta and probes the next stage', async () => {
    const ir = makeIr();
    ir.stages[0].invariants.domDelta = {
      appearedRole: 'dialog',
      appearedName: '已有结果',
    };
    ir.stages.push({
      ...structuredClone(ir.stages[0]),
      stageIndex: 1,
      stageName: '下一步',
      actions: [{ ...ir.stages[0].actions[0], targetName: '继续' }],
      invariants: { network: structuredClone(ir.stages[0].invariants.network) },
    });
    const item = fixture(ir);
    let target: ProbeTarget | undefined;
    try {
      const result = await probe({
        projectRoot: item.root,
        irPath: item.irPath,
        replay: async (_ir, currentTarget) => {
          target = currentTarget;
          return { before: '', after: '- heading "第二步完成"' };
        },
      });

      assert.equal(result.exitCode, 0);
      assert.deepEqual(target, { stageIndex: 1, actionIndex: 0 });
      const written = JSON.parse(fs.readFileSync(item.irPath, 'utf8'));
      assert.equal(written.stages[0].invariants.domDelta.appearedName, '已有结果');
      assert.equal(written.stages[1].invariants.domDelta.appearedName, '第二步完成');
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it('does not change files when every actionable stage already has domDelta', async () => {
    const ir = makeIr();
    ir.stages[0].invariants.domDelta = {
      appearedRole: 'dialog',
      appearedName: '已有结果',
    };
    const item = fixture(ir);
    try {
      const result = await probe({
        projectRoot: item.root,
        irPath: item.irPath,
        replay: async () => {
          throw new Error('must not replay');
        },
      });

      assert.match(result.reason ?? '', /都已有 domDelta|没有待探测/);
      assert.equal(result.written, undefined);
      assert.equal(fs.readFileSync(item.irPath, 'utf8'), item.content);
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it('probes the last triggersRequest action even when it is not the last action', async () => {
    const ir = makeIr();
    ir.stages[0].actions = [
      { ...ir.stages[0].actions[0], targetName: '第一个请求', triggersRequest: true },
      { ...ir.stages[0].actions[0], targetName: '第二个请求', triggersRequest: true },
      {
        actionType: 'FILL',
        targetRole: 'textbox',
        targetName: '备注',
        inputValue: 'x',
        timeoutMs: 2000,
        triggersRequest: false,
      },
    ];
    const item = fixture(ir);
    let target: ProbeTarget | undefined;
    try {
      await probe({
        projectRoot: item.root,
        irPath: item.irPath,
        replay: async (_ir, currentTarget) => {
          target = currentTarget;
          return { before: '', after: '- dialog "完成"' };
        },
      });

      assert.deepEqual(target, { stageIndex: 0, actionIndex: 1 });
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });
});
