/**
 * 把 IR 里的路由模式还原成拓扑里的那条确切路由。
 *
 * routePattern 和 targetUrlPattern 按契约是正则片段，两头可能带锚点。
 * 比较「是不是同一条路由」之前必须先剥掉，否则 ^/home 和 /home$ 会被
 * 当成两条。emitter、validate-ir、verify 三处都要用同一套剥法。
 */
export function exactRoute(pattern: string): string {
  return pattern.replace(/^\^/, '').replace(/\$$/, '');
}
