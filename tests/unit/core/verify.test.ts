import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { StateTransitionIR } from '../../../src/idt/core/ir-schema.js';
import { verifyCases } from '../../../src/idt/core/verify.js';

const flowId = 'flow_aabbccddee';

function makeIr(overrides: Partial<StateTransitionIR> = {}): StateTransitionIR {
  return {
    flowId,
    intent: '打开首页',
    oracle: 'regression-lock',
    description: '首页可用',
    initialRoute: '/home',
    setup: { notes: [] },
    unresolved: [],
    stages: [
      {
        stageIndex: 0,
        stageName: '首页',
        routePattern: '/home',
        actions: [
          {
            actionType: 'CLICK',
            targetRole: 'button',
            targetName: '提交',
            timeoutMs: 5000,
            triggersRequest: false,
          },
        ],
        invariants: { network: [] },
      },
    ],
    ...overrides,
  };
}

function makeTopology(elements: unknown[] = [{ role: 'button', name: '提交' }]) {
  return {
    routes: {
      '/home': { elements },
    },
  } as any;
}

function verify(
  ir = makeIr(),
  topology = makeTopology(),
  specContent: string | null = 'CURRENT',
) {
  return verifyCases(
    topology,
    [{ flowId: ir.flowId, ir, specContent }],
    { emit: () => 'CURRENT' },
  );
}

describe('verify generated cases', () => {
  it('returns no findings for a healthy case', () => {
    assert.deepEqual(verify(), []);
  });

  it('reports spec-drift when the regenerated spec differs byte for byte', () => {
    const findings = verify(makeIr(), makeTopology(), 'STALE');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].code, 'spec-drift');
    assert.equal(findings[0].level, 'error');
  });

  it('reports missing-evidence with probe guidance when the paired spec is absent', () => {
    const findings = verify(makeIr(), makeTopology(), null);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].code, 'missing-evidence');
    assert.equal(findings[0].level, 'error');
    assert.match(findings[0].message, /probe/);
    assert.equal(findings.some((finding) => finding.code === 'missing-spec'), false);
  });

  it('still reports missing-spec when the IR already has hard evidence', () => {
    const ir = makeIr({
      stages: [{
        ...makeIr().stages[0],
        invariants: {
          network: [{
            method: 'POST', urlPattern: '/api/submit', expectedStatus: 200, responseType: 'json',
          }],
        },
      }],
    });
    const findings = verify(ir, makeTopology(), null);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].code, 'missing-spec');
    assert.equal(findings.some((finding) => finding.code === 'missing-evidence'), false);
  });

  it('reports every unresolved item in the message', () => {
    const findings = verify(makeIr({ unresolved: ['按钮含义不明确', '缺少测试账号'] }));
    assert.equal(findings[0].code, 'unresolved');
    assert.match(findings[0].message, /按钮含义不明确/);
    assert.match(findings[0].message, /缺少测试账号/);
  });

  it('reports orphan-route when initialRoute is absent from the topology', () => {
    const findings = verify(makeIr({ initialRoute: '/removed' }));
    assert.equal(findings.some((finding) => finding.code === 'orphan-route'), true);
  });

  it('reports a missing action element with existing same-role candidates', () => {
    const topology = makeTopology([
      { role: 'button', name: '保存' },
      { role: 'button', name: '取消' },
      { role: 'link', name: '提交' },
    ]);
    const findings = verify(makeIr(), topology);
    assert.equal(findings[0].code, 'missing-element');
    assert.match(findings[0].message, /保存/);
    assert.match(findings[0].message, /取消/);
    assert.match(findings[0].message, /stageIndex 0/);
  });

  it('reports a missing routeGuard ready element', () => {
    const ir = makeIr({
      stages: [
        {
          ...makeIr().stages[0],
          actions: [],
          invariants: {
            network: [],
            routeGuard: {
              targetUrlPattern: '/home',
              readyRole: 'heading',
              readyName: '交易首页',
            },
          },
        },
      ],
    });
    const findings = verify(ir);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].code, 'missing-element');
  });

  it('resolves a routePattern after removing leading and trailing anchors', () => {
    const ir = makeIr({
      stages: [{ ...makeIr().stages[0], routePattern: '^/home$' }],
    });
    assert.deepEqual(verify(ir), []);
  });

  it('warns on an unmatched routePattern and skips element validation', () => {
    const ir = makeIr({
      stages: [{ ...makeIr().stages[0], routePattern: '/unknown' }],
    });
    const findings = verify(ir);
    assert.deepEqual(findings.map(({ code, level }) => ({ code, level })), [
      { code: 'unmatched-route-pattern', level: 'warning' },
    ]);
  });

  it('does not match a dynamic element without a name', () => {
    const findings = verify(makeIr(), makeTopology([{ role: 'button', dynamic: true }]));
    assert.equal(findings[0].code, 'missing-element');
  });

  // dynamic 元素的名字运行期才定，静态抓到的那个不可信。提取器目前不会同时给出
  // dynamic 和 name，但这条不变量不能指望提取器守——守在这里才拦得住。
  it('never matches a dynamic element even when it carries a name', () => {
    const findings = verify(
      makeIr(),
      makeTopology([{ role: 'button', dynamic: true, name: '提交' }]),
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].code, 'missing-element');
  });

  it('keeps dynamic elements out of the candidate list', () => {
    const findings = verify(
      makeIr(),
      makeTopology([
        { role: 'button', dynamic: true, name: '动态按钮' },
        { role: 'button', name: '静态按钮' },
      ]),
    );
    assert.equal(findings[0].code, 'missing-element');
    assert.match(findings[0].message, /静态按钮/);
    assert.doesNotMatch(findings[0].message, /动态按钮/);
  });

  it('warns when the whole case has neither actions nor a complete ready element', () => {
    const ir = makeIr({
      stages: [
        {
          ...makeIr().stages[0],
          actions: [],
          invariants: {
            network: [],
            routeGuard: { targetUrlPattern: '/home' },
          },
        },
      ],
    });
    const findings = verify(ir);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].code, 'weak-assertion');
    assert.equal(findings[0].level, 'warning');
  });

  it('does not report weak-assertion when the case has an action', () => {
    assert.equal(verify().some((finding) => finding.code === 'weak-assertion'), false);
  });

  it('treats a legacy topology node without elements as an empty list', () => {
    const topology = { routes: { '/home': {} } } as any;
    assert.doesNotThrow(() => verify(makeIr(), topology));
    assert.equal(verify(makeIr(), topology)[0].code, 'missing-element');
  });

  it('turns an emit exception into an error finding', () => {
    const findings = verifyCases(
      makeTopology(),
      [{ flowId, ir: makeIr(), specContent: 'CURRENT' }],
      {
        emit: () => {
          throw new Error('IR 无法重新装配');
        },
      },
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].code, 'spec-drift');
    assert.equal(findings[0].level, 'error');
    assert.match(findings[0].message, /IR 无法重新装配/);
  });

  // 需求文档原则 3：点击/勾选/选择必须绑到网络契约或路由守卫。但一条
  // targetUrlPattern 指向自己所在页的守卫，对「本来就不跳页」的点击恒为真，
  // 等于什么都没证明——实测产出过这种 spec，把接口 abort 掉它照样全绿。
  const clickIr = (over: Partial<StateTransitionIR['stages'][0]> = {}) =>
    makeIr({
      stages: [
        {
          stageIndex: 0,
          stageName: '提交',
          routePattern: '/home',
          actions: [
            {
              actionType: 'CLICK',
              targetRole: 'button',
              targetName: '提交',
              timeoutMs: 5000,
              triggersRequest: true,
            } as any,
          ],
          invariants: {
            network: [],
            routeGuard: { targetUrlPattern: '/home', readyRole: 'button', readyName: '提交' },
          },
          ...over,
        } as any,
      ],
    });

  it('rejects a route guard that merely asserts the page the action started on', () => {
    const findings = verify(clickIr());
    const tautological = findings.filter((f) => f.code === 'tautological-guard');
    assert.equal(tautological.length, 1);
    assert.equal(tautological[0].level, 'error');
  });

  it('accepts the guard when a network contract carries the evidence', () => {
    const ir = clickIr({
      invariants: {
        network: [
          { method: 'GET', urlPattern: '/api/submit', expectedStatus: 200, responseType: 'json' },
        ],
        routeGuard: { targetUrlPattern: '/home' },
      },
    } as any);
    assert.deepEqual(verify(ir).filter((f) => f.code === 'tautological-guard'), []);
  });

  it('does not report a tautological guard when domDelta carries the evidence', () => {
    const ir = clickIr({
      invariants: {
        network: [],
        routeGuard: { targetUrlPattern: '/home' },
        domDelta: { appearedRole: 'dialog', appearedName: '提交成功' },
      },
    } as any);
    assert.deepEqual(verify(ir).filter((f) => f.code === 'tautological-guard'), []);
  });

  it('accepts the guard when the action actually navigates elsewhere', () => {
    const ir = clickIr({
      invariants: { network: [], routeGuard: { targetUrlPattern: '/done$' } },
    } as any);
    assert.deepEqual(verify(ir).filter((f) => f.code === 'tautological-guard'), []);
  });

  it('leaves pure navigation cases alone — there the same-page guard is the point', () => {
    const ir = makeIr({
      stages: [
        {
          stageIndex: 0,
          stageName: '首页',
          routePattern: '/home',
          actions: [],
          invariants: {
            network: [],
            routeGuard: { targetUrlPattern: '/home', readyRole: 'button', readyName: '提交' },
          },
        } as any,
      ],
    });
    assert.deepEqual(verify(ir).filter((f) => f.code === 'tautological-guard'), []);
  });

  it('does not fire for FILL alone, which needs no hard evidence', () => {
    const ir = clickIr({
      actions: [
        {
          actionType: 'FILL',
          targetRole: 'textbox',
          targetName: '客户号',
          inputValue: '1',
          timeoutMs: 5000,
          triggersRequest: false,
        } as any,
      ],
    } as any);
    assert.deepEqual(verify(ir).filter((f) => f.code === 'tautological-guard'), []);
  });

  it('compares the two patterns with anchors stripped from both sides', () => {
    const ir = clickIr({
      routePattern: '^/home',
      invariants: { network: [], routeGuard: { targetUrlPattern: '/home$' } },
    } as any);
    assert.equal(
      verify(ir).filter((f) => f.code === 'tautological-guard').length,
      1,
      '^/home 和 /home$ 指的是同一条路由',
    );
  });

  it('returns all findings for a case and sorts cases by flowId', () => {
    const broken = makeIr({
      initialRoute: '/removed',
      unresolved: ['待确认'],
      stages: [{ ...makeIr().stages[0], routePattern: '/unknown', actions: [] }],
    });
    const later = { ...broken, flowId: 'flow_ffffffffff' };
    const earlier = { ...broken, flowId: 'flow_0000000000' };
    const findings = verifyCases(
      makeTopology(),
      [
        { flowId: later.flowId, ir: later, specContent: null },
        { flowId: earlier.flowId, ir: earlier, specContent: null },
      ],
      { emit: () => 'CURRENT' },
    );

    assert.deepEqual(
      findings.filter((finding) => finding.flowId === earlier.flowId).map((finding) => finding.code),
      ['missing-spec', 'unresolved', 'orphan-route', 'unmatched-route-pattern', 'weak-assertion'],
    );
    assert.deepEqual(
      [...new Set(findings.map((finding) => finding.flowId))],
      [earlier.flowId, later.flowId],
    );
  });
});
