import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_ROUTER_URL_OPTIONS, routerUrlOptions, type RouterUrlOptions } from './route-url-pure.js';

export * from './route-url-pure.js';

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
