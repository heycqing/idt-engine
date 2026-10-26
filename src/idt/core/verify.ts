import type { StateTransitionIR, TargetRole } from './ir-schema.js';
import type { PageElement, ProjectTopology } from '../schemas/topology.schema.js';

export type FindingLevel = 'error' | 'warning';

export type FindingCode =
  | 'spec-drift'
  | 'missing-spec'
  | 'orphan-spec'
  | 'invalid-ir'
  | 'unresolved'
  | 'orphan-route'
  | 'unmatched-route-pattern'
  | 'missing-element'
  | 'weak-assertion';

export interface VerifyFinding {
  level: FindingLevel;
  code: FindingCode;
  flowId: string;
  message: string;
}

export interface VerifyCase {
  flowId: string;
  ir: StateTransitionIR;
  specContent: string | null;
}

export interface VerifyOptions {
  /** 注入重新装配的方式，避免纯函数接触项目配置或文件系统。 */
  emit: (ir: StateTransitionIR) => string;
}

function finding(
  flowId: string,
  level: FindingLevel,
  code: FindingCode,
  message: string,
): VerifyFinding {
  return { level, code, flowId, message };
}

function exactRoute(pattern: string): string {
  return pattern.replace(/^\^/, '').replace(/\$$/, '');
}

function elementsOf(node: unknown): PageElement[] {
  if (!node || typeof node !== 'object') return [];
  const elements = (node as { elements?: unknown }).elements;
  return Array.isArray(elements) ? (elements as PageElement[]) : [];
}

function missingElementFinding(
  flowId: string,
  stageIndex: number,
  route: string,
  elements: PageElement[],
  role: TargetRole,
  name: string,
): VerifyFinding | null {
  const exists = elements.some(
    (element) => !element.dynamic && element.role === role && element.name === name,
  );
  if (exists) return null;

  const candidates = elements
    .filter(
      (element): element is PageElement & { name: string } =>
        !element.dynamic && element.role === role && typeof element.name === 'string',
    )
    .map((element) => element.name)
    .slice(0, 5);
  const candidateText = candidates.length > 0 ? candidates.join('、') : '无';
  return finding(
    flowId,
    'error',
    'missing-element',
    `用例 ${flowId} 的 stageIndex ${stageIndex} 在路由 ${route} 引用了不存在的元素 (${role}, ${name})；该路由同 role 的现有候选名：${candidateText}。请确认元素是否改名或已删除，并更新 IR。`,
  );
}

export function verifyCases(
  topology: Pick<ProjectTopology, 'routes'>,
  cases: VerifyCase[],
  options: VerifyOptions,
): VerifyFinding[] {
  const findings: VerifyFinding[] = [];
  const sortedCases = [...cases].sort((a, b) => a.flowId.localeCompare(b.flowId));

  for (const item of sortedCases) {
    const { flowId, ir, specContent } = item;

    if (specContent === null) {
      findings.push(
        finding(
          flowId,
          'error',
          'missing-spec',
          `用例 ${flowId} 缺少同名 .spec.ts；请从 IR 重新生成测试代码。`,
        ),
      );
    } else {
      try {
        if (options.emit(ir) !== specContent) {
          findings.push(
            finding(
              flowId,
              'error',
              'spec-drift',
              `用例 ${flowId} 的 .spec.ts 与当前源码重新装配的结果不一致；请重新执行 emit。`,
            ),
          );
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        findings.push(
          finding(
            flowId,
            'error',
            'spec-drift',
            `用例 ${flowId} 无法用当前源码重新装配：${reason}；请检查 IR 后重新生成 spec。`,
          ),
        );
      }
    }

    if (ir.unresolved.length > 0) {
      findings.push(
        finding(
          flowId,
          'error',
          'unresolved',
          `用例 ${flowId} 仍有未解决项：${ir.unresolved.join('；')}。请补全信息后重新生成 IR。`,
        ),
      );
    }

    if (!Object.hasOwn(topology.routes, ir.initialRoute)) {
      findings.push(
        finding(
          flowId,
          'error',
          'orphan-route',
          `用例 ${flowId} 的初始路由 ${ir.initialRoute} 已不在当前拓扑中；请确认路由是否改名或删除。`,
        ),
      );
    }

    for (const stage of ir.stages) {
      const route = exactRoute(stage.routePattern);
      if (!Object.hasOwn(topology.routes, route)) {
        findings.push(
          finding(
            flowId,
            'warning',
            'unmatched-route-pattern',
            `用例 ${flowId} 的 stageIndex ${stage.stageIndex} 路由模式 ${stage.routePattern} 无法精确对应当前拓扑；已跳过该阶段的元素校验，请人工确认。`,
          ),
        );
        continue;
      }

      const elements = elementsOf(topology.routes[route]);
      for (const action of stage.actions) {
        const result = missingElementFinding(
          flowId,
          stage.stageIndex,
          route,
          elements,
          action.targetRole,
          action.targetName,
        );
        if (result) findings.push(result);
      }

      const guard = stage.invariants.routeGuard;
      if (guard?.readyRole && guard.readyName) {
        const result = missingElementFinding(
          flowId,
          stage.stageIndex,
          route,
          elements,
          guard.readyRole,
          guard.readyName,
        );
        if (result) findings.push(result);
      }
    }

    const hasElementAssertionOrAction = ir.stages.some(
      (stage) =>
        stage.actions.length > 0 ||
        Boolean(
          stage.invariants.routeGuard?.readyRole &&
            stage.invariants.routeGuard.readyName,
        ),
    );
    if (!hasElementAssertionOrAction) {
      findings.push(
        finding(
          flowId,
          'warning',
          'weak-assertion',
          `用例 ${flowId} 只有 URL 断言，没有任何元素断言或动作；请补充可观察的页面行为。`,
        ),
      );
    }
  }

  return findings;
}
