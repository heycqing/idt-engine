import { segmentsMatch } from '../utils/path.js';
import type {
  ProjectTopology,
  RouteTopologyNode,
  SemanticIndex,
} from '../schemas/topology.schema.js';

export interface RoutePathResult {
  routePath: string[];
  start: string;
  end: string;
  candidates: string[];
}

function resolveTarget(
  targetRoute: string,
  routes: Record<string, RouteTopologyNode>
): string | null {
  if (Object.prototype.hasOwnProperty.call(routes, targetRoute)) {
    return targetRoute;
  }
  const matching = Object.keys(routes).filter((r) => segmentsMatch(r, targetRoute));
  if (matching.length === 1) {
    return matching[0];
  }
  return null;
}

/**
 * Pure function to find route path from topology and semantic index for a given intent.
 * Does not read clock or access filesystem.
 */
export function findRoutePath(
  topology: ProjectTopology,
  semanticIndex: SemanticIndex,
  intent: string
): RoutePathResult {
  // Collect hit keywords per route
  const hitKeywordsByRoute = new Map<string, Set<string>>();
  for (const routeKey of Object.keys(topology.routes)) {
    hitKeywordsByRoute.set(routeKey, new Set<string>());
  }

  for (const entry of semanticIndex.entries) {
    if (entry.keyword.length < 2) continue;
    if (!intent.includes(entry.keyword)) continue;
    if (hitKeywordsByRoute.has(entry.route)) {
      hitKeywordsByRoute.get(entry.route)!.add(entry.keyword);
    }
  }

  const candidateScores = new Map<string, number>();
  const candidateMinIndices = new Map<string, number>();

  for (const [routeKey, node] of Object.entries(topology.routes)) {
    const hitKeywords = hitKeywordsByRoute.get(routeKey) ?? new Set<string>();
    let score = hitKeywords.size;

    const hasTitleMatch = Boolean(
      node.title && node.title.trim().length >= 2 && intent.includes(node.title)
    );
    if (hasTitleMatch) {
      score += 5;
    }

    if (score > 0) {
      candidateScores.set(routeKey, score);

      const matchedStrings: string[] = Array.from(hitKeywords);
      if (hasTitleMatch) {
        matchedStrings.push(node.title);
      }

      let minIdx = Infinity;
      for (const str of matchedStrings) {
        const idx = intent.indexOf(str);
        if (idx !== -1 && idx < minIdx) {
          minIdx = idx;
        }
      }
      candidateMinIndices.set(routeKey, minIdx);
    }
  }

  // 命中词集合是另一个候选真子集的，没有提供任何新信息，只会把寻径变成一次
  // 注定失败的跨页搜索。典型例子：意图里的"全部"同时命中融资页和融券页，而
  // 融券页只命中这一个词。这条规则是可证明的，不靠长度之类的启发式——否则
  // "从购物车去结算"这种真实跨页流程会被误砍成单页。
  const matchedByRoute = new Map<string, Set<string>>();
  for (const routeKey of candidateScores.keys()) {
    const hits = new Set(hitKeywordsByRoute.get(routeKey) ?? []);
    const node = topology.routes[routeKey];
    if (node?.title && node.title.trim().length >= 2 && intent.includes(node.title)) {
      hits.add(node.title);
    }
    matchedByRoute.set(routeKey, hits);
  }

  const isProperSubset = (a: Set<string>, b: Set<string>): boolean =>
    a.size < b.size && [...a].every((item) => b.has(item));

  const redundant = new Set<string>();
  for (const [routeKey, hits] of matchedByRoute) {
    for (const [otherKey, otherHits] of matchedByRoute) {
      if (routeKey === otherKey || redundant.has(otherKey)) continue;
      if (isProperSubset(hits, otherHits)) {
        redundant.add(routeKey);
        break;
      }
    }
  }
  for (const routeKey of redundant) {
    candidateScores.delete(routeKey);
    candidateMinIndices.delete(routeKey);
  }

  const candidates = Array.from(candidateScores.keys()).sort((a, b) =>
    a.localeCompare(b)
  );

  const describeCandidates = (): string =>
    candidates
      .map((routeKey) => {
        const hits = [...(matchedByRoute.get(routeKey) ?? [])].sort();
        return `  ${routeKey}  ← ${hits.join('、') || '（无）'}`;
      })
      .join('\n');

  if (candidates.length === 0) {
    const error = new Error(
      `No candidate routes found for intent "${intent}". Please run idt:sync and check semantic index.`
    );
    (error as any).exitCode = 2;
    throw error;
  }

  // Determine start (smallest minimum index in intent, tie broken by lexicographical order)
  let start = candidates[0];
  let minStartIdx = candidateMinIndices.get(start)!;
  for (const cand of candidates) {
    const idx = candidateMinIndices.get(cand)!;
    if (idx < minStartIdx) {
      minStartIdx = idx;
      start = cand;
    } else if (idx === minStartIdx && cand.localeCompare(start) < 0) {
      start = cand;
    }
  }

  // Determine end (largest minimum index in intent, tie broken by lexicographical order)
  let end = candidates[0];
  let maxEndIdx = candidateMinIndices.get(end)!;
  for (const cand of candidates) {
    const idx = candidateMinIndices.get(cand)!;
    if (idx > maxEndIdx) {
      maxEndIdx = idx;
      end = cand;
    } else if (idx === maxEndIdx && cand.localeCompare(end) < 0) {
      end = cand;
    }
  }

  // If start and end are the same route, the path contains only this node
  if (start === end) {
    return {
      routePath: [start],
      start,
      end,
      candidates,
    };
  }

  // BFS from start to end
  const visited = new Set<string>([start]);
  const queue: Array<{ route: string; path: string[] }> = [
    { route: start, path: [start] },
  ];
  let foundPath: string[] | null = null;

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.route === end) {
      foundPath = current.path;
      break;
    }

    const node = topology.routes[current.route];
    if (!node) continue;

    // Collect and resolve outgoing edges
    const resolvedNextHops = new Set<string>();
    for (const transition of node.transitions) {
      const nextHop = resolveTarget(transition.targetRoute, topology.routes);
      if (nextHop && !visited.has(nextHop)) {
        resolvedNextHops.add(nextHop);
      }
    }

    // Sort next hops lexicographically to ensure stable shortest path
    const sortedHops = Array.from(resolvedNextHops).sort((a, b) =>
      a.localeCompare(b)
    );
    for (const nextHop of sortedHops) {
      visited.add(nextHop);
      queue.push({
        route: nextHop,
        path: [...current.path, nextHop],
      });
    }
  }

  if (!foundPath) {
    const error = new Error(
      [
        '意图匹配到多个互不连通的页面，无法确定要测哪条流程。',
        `起点 "${start}" 到终点 "${end}" 之间没有可达路径。`,
        '候选页面与把它们匹配进来的词：',
        describeCandidates(),
        '如果上面有词只是意图里的顺带措辞（而不是在指某个页面），换个说法去掉它再试。',
      ].join('\n'),
    );
    (error as any).exitCode = 2;
    throw error;
  }

  return {
    routePath: foundPath,
    start,
    end,
    candidates,
  };
}
