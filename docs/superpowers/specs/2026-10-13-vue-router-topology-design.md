# Vue Router 真实路由拓扑设计

## 目标

让 IDT 在不启动浏览器的情况下，从 Vue 2 / Vue Router 3 的路由源码中提取真实 URL，并把真实 URL 映射到对应 Vue 页面。完成后，财达宿主的 `.idt/topology.json` 应优先使用 `/credit/home`、`/subscribe/home` 等运行时路由，而不是仅根据文件路径推导的地址。

## 范围

本次实现覆盖：

- 配置一个或多个路由源码 glob；
- 路由对象中的 `path`、`component` 和嵌套 `children`；
- 默认导入、命名导入、本地变量别名；
- `import('...')` 动态导入；
- `createRetryableRouteLoader(() => import('...'))` 一类包装调用；
- 跨路由文件的组件 loader，例如财达 `tradeLoaders.js`；
- 主路由与信用路由分别声明、随后拼接的结构；
- 无法从路由源码解析的页面继续使用现有文件路径规则。

本次不覆盖：

- 执行任意路由源码；
- 运行浏览器读取 Vue Router 实例；
- 根据运行时权限或后端开关判断某条路由是否可达；
- 自动创建登录账号、交易数据或模型密钥；
- 根据 Git diff 自动生成整套回归测试。

## 配置契约

`IdtConfig` 增加可选字段：

```ts
routerGlobs?: string[];
```

缺省值为空数组，保持现有宿主行为不变。财达配置为：

```ts
routerGlobs: [
  'apps/caida/src/router/**/*.{js,ts}',
  'apps/caida/src/credit/router/**/*.{js,ts}',
],
```

## 架构

新增独立的 Vue Router 静态提取模块。模块读取 `routerGlobs` 匹配的 JS/TS 文件，建立两类索引：

1. 组件解析索引：标识符到组件文件的映射，支持本地声明、导入绑定、别名和动态导入。
2. 路由记录索引：路由对象的 `path`、`component`、`children`，递归合并父子路径。

模块输出：

```ts
Map<string, string[]>
```

键是项目内组件文件的绝对路径，值是该组件对应的真实路由列表。同一组件允许挂载到多个路由。

拓扑提取器先扫描页面内容、文案与跳转，再应用真实路由映射：

- 有真实路由时，为每个真实路由生成拓扑节点；
- 没有真实路由时，保留现有 `toRoutePattern` 文件路径推导；
- 多个页面意外映射到同一路由时，记录诊断并稳定选择，不静默产生不确定结果；
- 输出继续通过现有 Zod schema 验证。

## 数据流

```text
idt.config.ts
  -> pageGlobs 扫描 Vue 页面
  -> routerGlobs 扫描 Vue Router 源码
  -> 解析组件绑定与路由记录
  -> component file -> real route[]
  -> 页面语义/跳转提取
  -> 使用真实路由覆盖文件路径路由
  -> .idt/topology.json + semantic-index.json
```

## 错误处理

- `routerGlobs` 未配置：完全沿用旧行为。
- glob 没有匹配文件：输出诊断，页面仍使用文件路径路由。
- 动态表达式无法静态确定：跳过该条映射，不执行源码。
- 相对路径或 `@/` 别名无法解析：跳过并输出诊断。
- 路由文件语法错误：单文件降级，不能让其他可解析路由全部丢失。
- 父子路由：子路径以 `/` 开头时视为绝对路径，否则与父路径规范化拼接。

## 测试策略

严格按 TDD 实施：每项能力先写会因能力缺失而失败的测试，再写最小实现。

单元测试覆盖：

- `routerGlobs` 缺省兼容；
- 顶层路由到 Vue 文件的映射；
- 嵌套相对路径拼接；
- 绝对子路由；
- `createRetryableRouteLoader` 动态导入；
- 命名导入和本地别名；
- 跨文件 loader；
- 一个组件多个路由；
- 无法解析时回退文件路由；
- 路由映射后的语义关键词和跳转仍保留。

集成验证：

1. `pnpm test:idt` 全量通过。
2. 在财达宿主执行 `pnpm idt:sync`。
3. 对比路由源码静态集合与 `.idt/topology.json`，报告已映射、未映射、重复映射数量。
4. 抽查 `/credit/home`、`/subscribe/home`、`/trade/buy`、`/transfer/today`。

## 宿主接入

目标宿主为 `D:\jz-font-end\fabu\trade-monorepo` 的 `chore/teste2e` 分支。仅修改 IDT 接入相关文件，保留该仓库已有改动，不提交、不推送、不运行发布命令。

路由对齐后，补齐宿主 IDT 命令与 Playwright 配置。首次真实链路优先选择只读或低风险页面跳转；生成阶段先不加 `--yes`，人工检查 IR 和 spec 后再执行。

## 完成标准

- 引擎全量单测通过；
- 财达 `idt:sync` 成功退出；
- 拓扑包含财达真实普通与信用路由；
- 输出真实路由覆盖率和未解析原因；
- 当前 Vue 支持与 GitHub Actions 本地改动被完整保留；
- 不使用或泄露账号、token、模型密钥与生产数据；
- 真实浏览器链路若受登录态、测试账号或模型密钥阻塞，明确记录阻塞点，不虚报完成。
