import fs from 'node:fs';
import path from 'node:path';

export type RouterMode = 'hash' | 'history';

export interface RouterUrlOptions {
  mode: RouterMode;
  base?: string;
  /**
   * 每次导航都带上的查询串。宿主有免登录渠道旁路之类的开关时用它。
   * hash 模式下写在 # 之内，否则只进 window.location.search，
   * vue-router 的 to.query 读不到。
   */
  query?: Record<string, string>;
}

export const DEFAULT_ROUTER_URL_OPTIONS: Required<RouterUrlOptions> = {
  mode: 'history',
  base: '/',
  query: {},
};

function normalizeBase(base: string | undefined): string {
  const raw = (base ?? '/').trim();
  if (raw === '' || raw === '/') return '/';
  const withLeading = raw.startsWith('/') ? raw : `/${raw}`;
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
}

function queryString(query: RouterUrlOptions['query']): string {
  const entries = Object.entries(query ?? {});
  if (entries.length === 0) return '';
  return (
    '?' +
    entries
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&')
  );
}

/** 应用路由 → 浏览器地址。不带主机名，继续靠 Playwright 的 baseURL。 */
export function toBrowserUrl(
  route: string,
  options: RouterUrlOptions = DEFAULT_ROUTER_URL_OPTIONS,
): string {
  const base = normalizeBase(options.base);
  const path = (route.startsWith('/') ? route : `/${route}`) + queryString(options.query);

  if (options.mode === 'hash') {
    return `${base}#${path}`;
  }
  return base === '/' ? path : `${base}${path.slice(1)}`;
}

/** 把浏览器地址还原成应用路由。hash 模式取 # 之后、? 之前的部分。 */
export function fromBrowserUrl(
  url: string,
  options: RouterUrlOptions = DEFAULT_ROUTER_URL_OPTIONS,
): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }

  const base = normalizeBase(options.base);
  const expectedBasePath = base;
  if (options.mode === 'hash') {
    if (parsed.pathname !== expectedBasePath) return '';
    const route = parsed.hash.slice(1).split('?', 1)[0];
    return route.startsWith('/') ? route : '';
  }

  if (!parsed.pathname.startsWith(base)) return '';
  const route = `/${parsed.pathname.slice(base.length)}`;
  return route.startsWith('//') ? '' : route;
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
  let out = pattern;

  // 带查询串之后 URL 不再以路径结尾，尾部的 $ 锚点会匹配不上
  if (Object.keys(options.query ?? {}).length > 0 && out.endsWith('$')) {
    out = `${out.slice(0, -1)}(\?.*)?$`;
  }

  if (options.mode !== 'hash') return out;
  return out.startsWith('/') ? `#${out}` : out;
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
