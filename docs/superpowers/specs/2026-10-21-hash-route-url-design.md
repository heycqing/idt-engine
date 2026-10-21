# IDT Hash 路由 URL 装配设计

## 目标

让 hash 模式的 Vue 宿主能跑通 IDT。拓扑记录路由模式，emit 和 replay 把应用路由装配成真实浏览器 URL，`page.goto` 和 `page.waitForURL` 都打到对的地址。history 模式宿主的产物保持不变。

## 现状为什么错

财达宿主 `apps/caida/src/router/index.js` 是 `mode: 'hash'`。拓扑里存的是 `/credit/amount/finance`，`emitter.ts` 直接写 `page.goto("/credit/amount/finance")`，`page.waitForURL(new RegExp("/credit/amount/finance$"))`。真实地址是 `/#/credit/amount/finance`。

结果是首跳落到开发服务器的 404 或首页，后续每个 `waitForURL` 也全部对不上。拓扑、寻径、语义索引都是对的，只有最后一步"路由变 URL"缺了。自愈救不了这一类失败：aria 快照本身就取自错误的页面。

## 边界：IR 不变

IR 继续只存应用路由，`initialRoute` 和 `stages[].routePattern` 的写法不动。模型提示词、`ir-compiler`、`pathfinder`、语义索引一律不改。

理由有三条。一是同一条 IR 在宿主从 hash 换成 history 之后仍然成立，路由模式是部署形态，不是用例语义。二是模型没见过 `#`，让它产出带 hash 的路由只会增加幻觉面。三是 IR 要能人读、能手改。

知道 hash 的只有一处：把路由装配成 URL 的那一层。

## 配置

`idt.config.ts` 增加两个可选字段：

```ts
routerMode: 'hash' | 'history';
routerBase: string;
```

两个都可以不写。写了就覆盖自动检测，因为静态解析一定有盖不到的写法，宿主需要一个不改引擎就能纠正的出口。

## 检测规则

`extractVueRouterMappings` 在已经加载的 router 源文件上顺带识别，不额外读文件。

判为 hash：`new VueRouter({ mode: 'hash' })`；`createRouter({ history: createWebHashHistory(...) })`。

判为 history：`mode: 'history'`；`createWebHistory(...)`。

`mode` 写成变量、三元或其他表达式时不猜，按未检测到处理。

`base` 只认字符串字面量。财达写的是 `base: window.webConfig.BASE_URL`，运行期才有值，静态解析不了。这种情况留空，按 `/` 处理，并提示可以在 `idt.config.ts` 写死 `routerBase`。

同一批文件里解析出互相矛盾的模式时，取第一个出现的，并打印一条 warning 列出冲突来源。注释掉的 router 实例不参与判断——ts-morph 不会把注释解析成节点，这一条自然成立，财达 `src/credit/router/index.js` 里被注释掉的 `new VueRouter` 正好是这个情形。

没有 `routerGlobs`、或一个 router 实例都没扫到时，判为 history，与现状一致。

取值顺序从高到低：`idt.config.ts` 的 `routerMode` / `routerBase` → 静态检测结果 → `history` 和 `/`。

## 拓扑产物

`ProjectTopologySchema` 顶层增加可选字段：

```json
"router": { "mode": "hash", "base": "/" }
```

设为可选、`version` 不升。已经生成过 `.idt/topology.json` 的宿主不必立刻重新 sync，读到缺失的 `router` 就按 `{ mode: 'history', base: '/' }` 处理，行为与改动前逐字节一致。升版本会让所有既有宿主的产物一次性失效，换不到任何东西。

## URL 装配

新增 `src/idt/core/route-url.ts`：

```ts
export interface RouterUrlOptions {
  mode: 'hash' | 'history';
  base?: string;
}

export function toBrowserUrl(route: string, options?: RouterUrlOptions): string;
export function toUrlPattern(route: string, options?: RouterUrlOptions): string;
```

`toBrowserUrl` 给 `page.goto`，`toUrlPattern` 给 `page.waitForURL` 的正则片段。两者都不写主机名，继续靠 Playwright 的 `baseURL`。

| 模式 | base | 路由 | goto | waitForURL 片段 |
|---|---|---|---|---|
| history | `/` | `/credit/amount` | `/credit/amount` | `/credit/amount$` |
| hash | `/` | `/credit/amount` | `/#/credit/amount` | `#/credit/amount$` |
| hash | `/trade/` | `/credit/amount` | `/trade/#/credit/amount` | `#/credit/amount$` |
| hash | `/` | `/` | `/#/` | `#/$` |

history 模式的两列与现状逐字符相同，这是回归基线。

hash 模式的 pattern 不含 base。base 由部署决定，同一条 spec 在不同 base 下都该通过，锚在 `#` 上足够区分页面。

`toUrlPattern` 要对路由里的正则元字符做转义。现在 `emitter.ts` 把 `routePattern` 原样塞进 `new RegExp(...)`，路由里出现 `.` 或 `(` 就会变成通配。顺带修掉，history 模式下只有含元字符的路由产物会变。

## 调用点

三处，全部改成走 `route-url.ts`：

- `emitter.ts:188` 的 `page.goto`；
- `emitter.ts:289` 的 `page.waitForURL`；
- `replay.ts:21` 的 `goto` 与 `replay.ts:93` 的 `waitForURL`。

`healer` 经 `replay` 拿 aria 快照，不单独改。

`emitSpec(ir)` 增加第二个可选参数 `RouterUrlOptions`，缺省 history，保持现有调用和单测不动。`emitIrFile(projectRoot, irPath)` 自己从 `projectRoot` 的 `.idt/topology.json` 读 `router` 字段传进去；读不到就用缺省。`replay` 同样从 projectRoot 读。

这样 IR 文件里不出现路由模式，`pnpm idt:emit` 单独使用时也能拿到正确的模式，代价只是 emit 多读一次拓扑文件。

## 不在本设计范围

Playwright 配置和 `replay.ts:107` 里写死的 `3000` 端口与 hash 无关，属于宿主接入参数，另行处理。

登录态同样不在范围内。hash 修好之后，带全局路由守卫的宿主仍然会被弹回登录页，那是另一件事。

## 测试策略

严格按 TDD 实施：

1. `toBrowserUrl` 在 history 模式下原样返回，包含根路由；
2. `toBrowserUrl` 在 hash 模式下插入 `#`，根路由得到 `/#/`；
3. `toBrowserUrl` 在带 base 时把 base 放在 `#` 之前，并处理 base 结尾有无斜杠两种写法；
4. `toUrlPattern` 在 history 模式下与改动前的输出一致；
5. `toUrlPattern` 在 hash 模式下锚在 `#` 上且不含 base；
6. `toUrlPattern` 转义路由里的正则元字符；
7. 检测器识别 `mode: 'hash'`、`createWebHashHistory`、`mode: 'history'`、`createWebHistory`；
8. 检测器对表达式写法的 `mode` 与 `base` 不猜，退回缺省并给出提示；
9. 检测器忽略被注释掉的 router 实例；
10. 检测器在冲突时取第一个并 warning；
11. `idt.config.ts` 的 `routerMode` / `routerBase` 覆盖检测结果；
12. 拓扑写出 `router` 字段；缺少该字段的旧拓扑按 history 读入且不报错；
13. `emitSpec` 在 hash 选项下产出带 `#` 的 `goto` 与 `waitForURL`，不传选项时产物与现有 fixture 逐字节相同；
14. `emitIrFile` 从拓扑读到 hash 后产出带 `#` 的 spec；
15. `replay` 用同一套装配结果发起 `goto` 与 `waitForURL`；
16. `pnpm test:idt` 和 `pnpm exec tsc --noEmit` 全部通过。

第 13 条的 fixture 逐字节比对是 history 宿主的回归闸门。

## 文档

README 说明 hash 宿主会被自动识别，以及 `routerMode` / `routerBase` 两个兜底字段的用法和适用场景。

## 完成标准

- 财达宿主执行 `pnpm idt:sync` 后，`.idt/topology.json` 顶层出现 `"router": { "mode": "hash", "base": "/" }`；
- 由该拓扑 emit 出的 spec 首行是 `await page.goto("/#/credit/...")`，`waitForURL` 锚在 `#` 上；
- 现有 history 模式 fixture 的 spec 产物逐字节不变；
- 缺少 `router` 字段的旧拓扑仍可正常 emit；
- 全量类型检查与单元测试通过。
