import fs from 'node:fs';
import path from 'node:path';

export type RouterMode = 'hash' | 'history';

export interface RouterUrlOptions {
  mode: RouterMode;
  base?: string;
}

export const DEFAULT_ROUTER_URL_OPTIONS: Required<RouterUrlOptions> = {
  mode: 'history',
  base: '/',
};

function normalizeBase(base: string | undefined): string {
  const raw = (base ?? '/').trim();
  if (raw === '' || raw === '/') return '/';
  const withLeading = raw.startsWith('/') ? raw : `/${raw}`;
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
}

/** 应用路由 → 浏览器地址。不带主机名，继续靠 Playwright 的 baseURL。 */
export function toBrowserUrl(
  route: string,
  options: RouterUrlOptions = DEFAULT_ROUTER_URL_OPTIONS,
): string {
  const base = normalizeBase(options.base);
  const path = route.startsWith('/') ? route : `/${route}`;

  if (options.mode === 'hash') {
    return `${base}#${path}`;
  }
  return base === '/' ? path : `${base}${path.slice(1)}`;
}

/**
 * IR 的 routeGuard.targetUrlPattern 按契约就是正则片段（fixture 里形如
 * "/checkout$"），不是路由，所以这里只在 hash 模式下把锚点前移到 #，
 * 不做转义——转义会把合法的正则弄坏。
 *
 * 结果不含 base：base 由部署决定，同一条 spec 换 base 仍该通过。
 */
export function toGuardPattern(
  pattern: string,
  options: RouterUrlOptions = DEFAULT_ROUTER_URL_OPTIONS,
): string {
  if (options.mode !== 'hash') return pattern;
  return pattern.startsWith('/') ? `#${pattern}` : pattern;
}

/** 从拓扑顶层的 router 字段读出选项，缺失按 history。 */
export function routerUrlOptions(topology: {
  router?: { mode: RouterMode; base?: string };
}): RouterUrlOptions {
  return topology.router ?? DEFAULT_ROUTER_URL_OPTIONS;
}

/** 从 <projectRoot>/.idt/topology.json 读路由模式。读不到按 history。 */
export function readRouterOptions(projectRoot: string): RouterUrlOptions {
  const topologyPath = path.resolve(projectRoot, '.idt', 'topology.json');
  if (!fs.existsSync(topologyPath)) return DEFAULT_ROUTER_URL_OPTIONS;
  try {
    return routerUrlOptions(JSON.parse(fs.readFileSync(topologyPath, 'utf8')));
  } catch {
    return DEFAULT_ROUTER_URL_OPTIONS;
  }
}
