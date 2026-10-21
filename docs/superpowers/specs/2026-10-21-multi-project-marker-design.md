# IDT 多项目标志设计

## 目标

一个宿主仓库里可以有多个相互独立的 IDT 项目。业务方只加一行标志，不需要各自一套配置、密钥和 Playwright 文件。单项目宿主的行为和产物逐字节不变。

## 为什么需要

财达与粤开 96% 的页面相对路径相同，其中 175 个内容不同。八个券商全部共有的页面路径有 165 个。

当前引擎只有一个命名空间：`topology.routes` 以路由路径字符串为键，`semantic-index` 是扁平的 `{keyword, route}` 数组，两者各只有一份，落在 `projectRoot/.idt/` 下。把第二个券商的 globs 加进同一份配置，223 条路由会撞键，去重逻辑静默丢掉一半；而语义索引被污染得更彻底——同一个关键词命中八条路由，`findRoutePath` 的候选集直接失效。实测在单个 app 内"全部"这一个词撞上两个页面，就已经让寻径器选错起终点。

## 抽象

IDT 项目是一个对象，宿主仓库里可以有多个实例。当前实现把三件事绑在同一个目录上：项目身份、配置位置、产物位置。解绑之后：

- **身份**由业务方目录里的标志决定；
- **配置与密钥**留在仓库根的 IDT 根目录，全仓共用一份；
- **产物**跟着各自的项目目录走，物理隔离。

## IDT 根目录与项目的关系

IDT 根目录仍然是"从当前工作目录向上找到的最近的 `idt.config.ts`"，定义见项目就近配置那份设计。

标志**不是** `idt.config.ts`，所以向上查找会越过被标记的业务方目录，一路走到仓库根。`.env.idt.local` 的解析因此自动落在根目录，八个项目共用一份密钥，这一块不需要任何改动。

## 标志

业务方 `package.json` 增加一个字段：

```json
{
  "name": "@trade/caida",
  "idt": { "project": "caida" }
}
```

`project` 可以省略，默认取所在目录名。需要覆盖默认扫描范围时可以写在同一个对象里：

```json
{ "idt": { "project": "caida", "pageGlobs": ["src/views/**/*.vue"], "routerGlobs": ["src/router/**/*.js"] } }
```

选 `package.json` 而不是新增文件，是因为业务方目录里已经有这份清单，不额外增加一个只有一行内容的文件。

## 发现

`idt.config.ts` 增加可选字段：

```ts
projectGlobs: ['apps/*', 'packages/*']   // 默认值
```

引擎在这些目录下找带 `idt` 字段的 `package.json`，每找到一个就得到一个项目。

找不到任何标志时，退化为单项目：项目根就是 IDT 根目录，globs 取 `idt.config.ts` 顶层的 `pageGlobs` / `routerGlobs` / `localeFiles`，产物路径与现在完全一致。这是单项目宿主的兼容路径，必须逐字节不变。

## 每个项目的 globs

标志里写了就用标志的。没写就按项目根目录探测，与接入脚本的探测规则一致：存在哪个目录就启用哪条 glob。

| 目录 | glob |
| --- | --- |
| `src/views` | `src/views/**/*.{tsx,jsx,ts,js,vue}` |
| `src/credit/views` | `src/credit/views/**/*.{tsx,jsx,ts,js,vue}` |
| `src/pages` | `src/pages/**/*.{tsx,jsx,ts,js,vue}` |
| `src/app` | `src/app/**/page.{tsx,jsx}` |
| `src/router` | `src/router/**/*.{js,ts}` |
| `src/credit/router` | `src/credit/router/**/*.{js,ts}` |

glob 相对项目根解析，不是相对 IDT 根。

## 产物

每个项目的产物落在自己的项目根下：

```
apps/caida/.idt/topology.json
apps/caida/.idt/semantic-index.json
apps/caida/tests/e2e/generated/<flowId>.spec.ts

apps/yuekai/.idt/...
```

单项目宿主仍然是 `<IDT 根>/.idt/` 和 `<IDT 根>/tests/e2e/generated/`。

落盘逻辑本身不改——它一直是"相对传入的 projectRoot"，只是现在传进去的是项目根而不是 IDT 根。宿主 `.gitignore` 里不带前导斜杠的 `.idt/` 模式在任意层级生效，不用动。

拓扑顶层增加可选的 `project` 字段，单看一份 `topology.json` 就能认出它属于谁。字段可选，缺失的旧产物照常读入。

## 项目选择

命令按这个顺序确定作用于哪个项目：

1. 显式 `--project <name>`；
2. 当前工作目录落在某个项目根之内，取该项目；
3. 只有一个项目时取它；
4. 否则报错，列出可选项目名，退出码 `2`。

`sync` 是例外：不带选择器时同步全部项目，这是最常用的形态。

## 不在本设计范围

接入脚本写入标志。先手工加一行，`link-host` 的 `--project` 留到后面。

跨项目的共享页面识别。八个券商有 165 条同名路由，但内容不同，当前设计就是把它们当成八个互不相干的对象。真要做"共享组件变更影响哪些券商"是另一件事。

拓扑边稀疏、关键词碰撞、文件路径兜底造假路由这三个已知问题，与本设计无关。

## 测试策略

严格按 TDD 实施：

1. 没有任何标志时退化为单项目，项目根等于 IDT 根，globs 取配置顶层；
2. 单项目模式下产物路径与改动前一致；
3. 发现 `apps/*` 下带 `idt` 字段的 `package.json`，每个得到一个项目；
4. `project` 省略时取目录名；
5. 标志里的 globs 覆盖探测结果；
6. 没写 globs 时按目录存在性探测，glob 相对项目根；
7. `projectGlobs` 可在 `idt.config.ts` 里覆盖默认的 `apps/*`、`packages/*`；
8. 按名字选择项目；选不到时报错并列出可选项；
9. 工作目录在项目根内时自动推断该项目；
10. 多项目且无法推断时退出码为 `2`，错误信息列出全部项目名；
11. 两个项目各自写出自己的 `.idt/`，互不覆盖，`project` 字段正确；
12. 缺少 `project` 字段的旧拓扑仍可读入；
13. `.env.idt.local` 仍从 IDT 根读取，不受项目切换影响；
14. `pnpm test:idt` 和 `pnpm exec tsc --noEmit` 全部通过。

## 完成标准

- 财达与粤开各加一行标志后，`pnpm idt:sync` 一次写出两套互不干扰的拓扑；
- 两套语义索引物理隔离，`/credit/amount/finance` 在两边各自指向本项目的文件；
- `pnpm idt --project yuekai "<intent>"` 的 spec 落在 `apps/yuekai/tests/e2e/generated/`；
- 全仓只有一份 `idt.config.ts` 和一份 `.env.idt.local`；
- 去掉标志后行为与改动前完全一致；
- 全量类型检查与单元测试通过。
