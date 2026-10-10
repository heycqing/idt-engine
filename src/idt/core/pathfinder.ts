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

  const candidates = Array.from(candidateScores.keys()).sort((a, b) =>
    a.localeCompare(b)
  );

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
      `Cannot find route path from "${start}" to "${end}"`
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
