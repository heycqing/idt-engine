import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  formatHitMismatchWarning,
  probe,
  type ProbeTarget,
} from '../../../src/idt/core/prober.js';
import type { StateTransitionIR } from '../../../src/idt/core/ir-schema.js';
import type { ObservedElement } from '../../../src/idt/core/dom-observe.js';
import type { ReplayPage } from '../../../src/idt/core/replay.js';

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

function replayResult(
  before: string,
  after: string,
  beforeUrl = 'http://host/form',
  afterUrl = beforeUrl,
) {
  return { before, after, beforeUrl, afterUrl };
}

function observed(
  values: Partial<ObservedElement>[],
): ObservedElement[] {
  return values.map((value, index) => ({
    tag: 'div',
    role: null,
    ownText: `元素${index}`,
    alt: null,
    css: `#item-${index}`,
    visible: true,
    ...value,
  }));
}

function domReplayResult(
  beforeObserved: ObservedElement[],
  afterObserved: ObservedElement[],
  beforeUrl = 'http://host/form',
  afterUrl = beforeUrl,
  hit: string | null = null,
) {
  return { before: '', after: '', beforeUrl, afterUrl, beforeObserved, afterObserved, hit };
}

function hitReplayResult(hit: string | null) {
  const target = {
    tag: 'button',
    role: null,
    ownText: '提交',
    css: '#app > main > button.submit',
  };
  return domReplayResult(
    observed([target]),
    observed([
      target,
      { tag: 'div', role: 'dialog', ownText: '提交成功', css: '#success' },
    ]),
    'http://host/form',
    'http://host/form',
    hit,
  );
}

describe('probe', () => {
  it('formats a clear warning with the actual and IR target paths', () => {
    const warning = formatHitMismatchWarning({
      expected: '#app > main > button.submit',
      actual: '#app > aside > button.other',
    });

    assert.match(warning, /点击实际落在/);
    assert.match(warning, /#app > aside > button\.other/);
    assert.match(warning, /IR 指的是/);
    assert.match(warning, /#app > main > button\.submit/);
  });

  for (const [name, hit] of [
    ['the target itself', '#app > main > button.submit'],
    ['an ancestor of the target', '#app > main'],
    ['a descendant of the target', '#app > main > button.submit > span'],
  ] as const) {
    it(`does not report a hit mismatch when the click lands on ${name}`, async () => {
      const item = fixture();
      try {
        const result = await probe({
          projectRoot: item.root,
          irPath: item.irPath,
          replay: async () => hitReplayResult(hit),
        });

        assert.equal(result.hitMismatch, undefined);
      } finally {
        fs.rmSync(item.root, { recursive: true, force: true });
      }
    });
  }

  // 祖先判定必须对齐到 ' > ' 分隔符。裸 startsWith 会把 button.submit 和
  // button.submitAll 这种兄弟关系误判成祖先，真实的 mismatch 就被静默吞掉，
  // 正好废掉这个功能存在的理由。
  it('still reports a sibling whose selector shares a string prefix', async () => {
    const item = fixture();
    try {
      const result = await probe({
        projectRoot: item.root,
        irPath: item.irPath,
        replay: async () => hitReplayResult('#app > main > button.sub'),
      });

      assert.deepEqual(result.hitMismatch, {
        expected: '#app > main > button.submit',
        actual: '#app > main > button.sub',
      });
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it('reports an unrelated hit without changing exit code or evidence writes', async () => {
    const item = fixture();
    try {
      const result = await probe({
        projectRoot: item.root,
        irPath: item.irPath,
        replay: async () => hitReplayResult('#app > aside > button.other'),
      });

      assert.deepEqual(result.hitMismatch, {
        expected: '#app > main > button.submit',
        actual: '#app > aside > button.other',
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.written, true);
      assert.equal(fs.existsSync(item.specPath), true);
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it('ignores a missing recorded hit', async () => {
    const item = fixture();
    try {
      const result = await probe({
        projectRoot: item.root,
        irPath: item.irPath,
        replay: async () => hitReplayResult(null),
      });

      assert.equal(result.hitMismatch, undefined);
      assert.equal(result.exitCode, 0);
      assert.equal(result.written, true);
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it('continues probing when hit probe installation throws', async () => {
    const item = fixture();
    let observation = 0;
    let clicked = false;
    const target = observed([
      { tag: 'button', ownText: '提交', css: '#app > button.submit' },
    ])[0];
    const page: ReplayPage = {
      url: () => 'http://host/form',
      async goto() {},
      async click() { clicked = true; },
      async fill() {},
      async check() {},
      async selectOption() {},
      async waitForURL() {},
      async waitForVisible() {},
      async ariaSnapshot() { return ''; },
      async observe() {
        observation += 1;
        return observation === 1
          ? [target]
          : [target, ...observed([
            { tag: 'div', role: 'dialog', ownText: '提交成功', css: '#success' },
          ])];
      },
      async installHitProbe() { throw new Error('blocked by CSP'); },
      async readHit() { return null; },
    };

    try {
      const result = await probe({
        projectRoot: item.root,
        irPath: item.irPath,
        launchReplay: async (run) => run(page),
      });

      assert.equal(clicked, true);
      assert.equal(result.exitCode, 0);
      assert.equal(result.written, true);
      assert.equal(result.hitMismatch, undefined);
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it('writes role/name evidence for a newly observed semantic element', async () => {
    const item = fixture();
    try {
      const result = await probe({
        projectRoot: item.root,
        irPath: item.irPath,
        replay: async () => domReplayResult(
          observed([{ tag: 'button', ownText: '提交', css: '#submit' }]),
          observed([
            { tag: 'button', ownText: '提交', css: '#submit' },
            { tag: 'div', role: 'dialog', ownText: '提交成功', css: '#success' },
          ]),
        ),
      });

      assert.equal(result.observation, 'dom');
      assert.deepEqual(result.delta, { appearedRole: 'dialog', appearedName: '提交成功' });
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it('writes selector evidence for a newly observed text-only element', async () => {
    const item = fixture();
    try {
      const result = await probe({
        projectRoot: item.root,
        irPath: item.irPath,
        replay: async () => domReplayResult(
          observed([{ ownText: '原内容', css: '#old' }]),
          observed([
            { ownText: '原内容', css: '#old' },
            { ownText: '查看详情', css: '#app > div.details' },
          ]),
        ),
      });

      assert.equal(result.observation, 'dom');
      assert.deepEqual(result.delta, {
        appearedSelector: '#app > div.details',
        appearedText: '查看详情',
      });
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it('falls back to aria when DOM observation returns an empty array', async () => {
    const item = fixture();
    try {
      const result = await probe({
        projectRoot: item.root,
        irPath: item.irPath,
        replay: async () => ({
          ...replayResult('', '- dialog "完成"'),
          beforeObserved: [],
          afterObserved: [],
        }),
      });

      assert.equal(result.observation, 'aria');
      assert.deepEqual(result.delta, { appearedRole: 'dialog', appearedName: '完成' });
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it('keeps route evidence ahead of supplied DOM observations', async () => {
    const item = fixture();
    try {
      const result = await probe({
        projectRoot: item.root,
        irPath: item.irPath,
        replay: async () => domReplayResult(
          observed([{ ownText: '旧', css: '#old' }]),
          observed([{ role: 'dialog', ownText: '新', css: '#new' }]),
          'http://host/form',
          'http://host/done',
        ),
      });

      assert.equal(result.evidence, 'route');
      assert.equal(result.observation, undefined);
      const written = JSON.parse(fs.readFileSync(item.irPath, 'utf8'));
      assert.equal(written.stages[0].invariants.domDelta, undefined);
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });
  it('writes the unique appeared element to the IR and re-emits the spec', async () => {
    const item = fixture();
    try {
      const result = await probe({
        projectRoot: item.root,
        irPath: item.irPath,
        replay: async () => replayResult(
          '- button "提交"',
          '- button "提交"\n- dialog "提交成功"',
        ),
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.written, true);
      assert.equal(result.evidence, 'dom');
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
        replay: async () => replayResult('', '- banner "顶部"'),
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
        replay: async () => replayResult('', '- dialog "确认"\n- button "关闭"'),
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
        replay: async () => replayResult('', '- text "动态结果"\n- button "确认"'),
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
        replay: async () => replayResult('', '- dialog "先出现"\n- button "后出现"'),
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
    const replay = async () => replayResult('', '- dialog "完成"');
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
        replay: async () => replayResult('', '- dialog "确认"\n- button "关闭"'),
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
        replay: async () => replayResult('- button "提交"', '- button "提交"'),
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
        replay: async () => replayResult('', '- button "确认"\n- banner "顶部"'),
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
        replay: async () => replayResult('- button "提交"', '- button "提交"'),
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
          return replayResult('', '- heading "第二步完成"');
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
          return replayResult('', '- dialog "完成"');
        },
      });

      assert.deepEqual(target, { stageIndex: 0, actionIndex: 1 });
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it('writes a changed route as the preferred evidence', async () => {
    const item = fixture();
    try {
      const result = await probe({
        projectRoot: item.root,
        irPath: item.irPath,
        replay: async () => replayResult(
          '- button "提交"',
          '- heading "完成"',
          'http://host/form',
          'http://host/iframePage',
        ),
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.evidence, 'route');
      assert.deepEqual(result.route, {
        targetUrlPattern: '/iframePage',
        discardedReady: false,
      });
      const written = JSON.parse(fs.readFileSync(item.irPath, 'utf8'));
      assert.deepEqual(written.stages[0].invariants.routeGuard, {
        targetUrlPattern: '/iframePage',
      });
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it('discards stale route ready assertions after navigation', async () => {
    const ir = makeIr();
    ir.stages[0].invariants.routeGuard = {
      targetUrlPattern: '/form',
      readyRole: 'heading',
      readyName: '旧页面标题',
    };
    const item = fixture(ir);
    try {
      const result = await probe({
        projectRoot: item.root,
        irPath: item.irPath,
        replay: async () => replayResult('', '', 'http://host/form', 'http://host/done'),
      });

      assert.deepEqual(result.route, {
        targetUrlPattern: '/done',
        discardedReady: true,
      });
      const written = JSON.parse(fs.readFileSync(item.irPath, 'utf8'));
      assert.deepEqual(written.stages[0].invariants.routeGuard, {
        targetUrlPattern: '/done',
      });
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it('does not write domDelta when the URL changed even if the DOM changed', async () => {
    const item = fixture();
    try {
      await probe({
        projectRoot: item.root,
        irPath: item.irPath,
        replay: async () => replayResult(
          '',
          '- dialog "DOM 也变了"',
          'http://host/form',
          'http://host/done',
        ),
      });

      const written = JSON.parse(fs.readFileSync(item.irPath, 'utf8'));
      assert.equal(written.stages[0].invariants.domDelta, undefined);
      assert.equal(written.stages[0].invariants.routeGuard.targetUrlPattern, '/done');
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it('rejects --pick for route evidence without changing files', async () => {
    const item = fixture();
    try {
      const result = await probe({
        projectRoot: item.root,
        irPath: item.irPath,
        pick: 1,
        replay: async () => replayResult('', '', 'http://host/form', 'http://host/done'),
      });

      assert.equal(result.exitCode, 2);
      assert.match(result.reason ?? '', /--pick.*URL|URL.*--pick/);
      assert.equal(fs.readFileSync(item.irPath, 'utf8'), item.content);
      assert.equal(fs.existsSync(item.specPath), false);
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });
});
