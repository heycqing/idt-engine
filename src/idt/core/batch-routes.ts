import type { ProjectTopology } from '../schemas/topology.schema.js';

export interface BatchRouteOptions {
  /** 只要路径里包含这个子串的路由。 */
  filter?: string;
  /** 排除路径里包含这些子串的路由。 */
  exclude: string[];
  limit?: number;
}

export function normalizeBatchExcludes(
  commandLineValue: string | undefined,
  markerValue: string[] | undefined,
): string[] {
  if (commandLineValue === undefined) return markerValue ?? [];
  return commandLineValue
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * 挑出值得批量生成的路由。
 *
 * 只收至少有一个"有确定名字"的元素的路由——没有可断言的东西，生成出来
 * 也是废的。`dynamic` 的元素不算：它的名字运行期才定，断言不了。
 *
 * exclude 是为白名单型宿主准备的：粤开那几家的渠道码不是免登录旁路而是
 * 原生 App 模式，credit 路由不在白名单里，一律被重定向，批量生成它们
 * 纯属浪费模型调用。
 */
export function selectBatchRoutes(
  topology: Pick<ProjectTopology, 'routes'>,
  options: BatchRouteOptions,
): string[] {
  let routes = Object.entries(topology.routes)
    .filter(([, node]) =>
      ((node as { elements?: Array<{ name?: string; deferred?: true }> }).elements ?? []).some(
        (element) => !element.deferred && typeof element.name === 'string' && element.name.length > 0,
      ),
    )
    .map(([route]) => route)
    .sort();

  if (options.filter) {
    routes = routes.filter((route) => route.includes(options.filter!));
  }

  if (options.exclude.length > 0) {
    routes = routes.filter((route) => !options.exclude.some((part) => route.includes(part)));
  }

  if (options.limit && options.limit > 0) {
    routes = routes.slice(0, options.limit);
  }

  return routes;
}
