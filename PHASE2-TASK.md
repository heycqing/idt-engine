# 阶段 2 任务（只做这一阶段）

在现有阶段 1 代码上实现寻径、IR schema、本地校验、可注入的模型客户端。完成后 `pnpm test:idt` 必须退出码 0，阶段 1 的测试继续通过。

不要实现装配器、Playwright、自愈、GitHub Actions。不要安装 `openai`、`playwright`、`cross-spawn`。不要改 `PHASE1-TASK.md` 和本文件。不要 git commit。不要修改 `D:\mine-prop\过去的知识图谱`。

## 新增文件

```text
src/idt/core/intent.ts
src/idt/core/pathfinder.ts
src/idt/core/ir-schema.ts
src/idt/core/validate-ir.ts
src/idt/core/ir-compiler.ts
src/idt/core/openai-client.ts
src/idt/core/intent.test.ts
src/idt/core/pathfinder.test.ts
src/idt/core/validate-ir.test.ts
src/idt/core/ir-compiler.test.ts
```

可以给 `src/idt/extract/topology.ts` 增加 `readSemanticIndex(projectRoot)`，不要改变阶段 1 的提取结果。

`package.json` 增加 `"idt": "tsx scripts/idt/cli.ts gen"`。根命令不要设必填位置参数。`sync` 保持原样。

## 意图与 flowId

`src/idt/core/intent.ts` 导出：

- `normalizeIntent(intent: string)`：trim；连续空白（含换行、制表符）压成一个空格；只把 ASCII `A-Z` 变成 `a-z`。中文不变。
- `flowIdFromIntent(intent: string)`：对 `normalizeIntent` 的结果做 SHA-256，取 hex 前 10 位，前缀 `flow_`。同一规范化结果必须得到同一个 id。

## 寻径

`findRoutePath(topology, semanticIndex, intent)` 是纯函数，不读时钟、不访问磁盘。

1. 忽略长度小于 2 的 keyword。命中条件只有 `intent.includes(keyword)`。不要分词，不要 BM25，不要按得分第一名、第二名决定起终点。
2. 每个路由的得分 = 命中的不同 keyword 个数。若 `intent.includes(node.title)` 且 title trim 后长度 ≥ 2，再加 5。
3. 得分为 0 的路由不是候选。没有任何候选时抛出 `exitCode === 2` 的错误，消息里同时含 `idt:sync`。
4. 候选名单按路径字典序排列，只放在返回值的 `candidates` 里。起点和终点不按名次选。
5. 每个候选路由取其命中关键词（含被包含的 title）在意图中的最小下标。下标最小的是起点，下标最大的是终点。最早下标并列时，路径字典序较小者为起点。最晚下标并列时，路径字典序较小者为终点。起点和终点是同一路由时，路径只有这一个节点。
6. BFS 从起点走到终点。边是 `transitions[].targetRoute`。下一跳必须能落到 `routes` 的某个键：键相同，或 `segmentsMatch(routeKey, targetRoute)` 恰好命中一个键。零个或多个键都匹配时，这条边不能走。已访问节点不要再次入队。同一节点的出边按解析后的路由键字典序入队，保证最短路径稳定。
7. 走不到终点时抛出 `exitCode === 2`，消息里同时含起点和终点的路径字符串。不要编造中间页。

返回 `{ routePath: string[], start: string, end: string, candidates: string[] }`。

复用 `src/idt/utils/path.ts` 里的 `segmentsMatch`。

## 语义索引读取

`readSemanticIndex(projectRoot)` 读取 `.idt/semantic-index.json`，用已有 `SemanticIndexSchema` 校验。文件缺失或校验失败时抛出 `exitCode === 2`。

## IR schema

把实现描述第 8 节的 schema 放到 `src/idt/core/ir-schema.ts` 并导出类型 `StateTransitionIR`。`assertResponseFields` 的键在校验阶段再查：用 `.` 分段，每段必须匹配 `/^[A-Za-z_$][A-Za-z0-9_$]*$/`。不支持数组下标。

`RouteGuardSchema` 的 `readyRole` 与 `ActionSchema` 的 `targetRole` 使用同一个枚举。

## 本地校验

`validateIr(ir, options)`。`options` 含：

- `projectRoot: string`
- `routePath: string[]`
- `proseCase?: string`
- `mode: 'gen' | 'emit'`
- `fileStem?: string`（仅 emit）

规则：

- `gen`：调用方已经把 `flowId` 写成 `flowIdFromIntent(ir.intent)`，把 `oracle` 写成有散文则 `prose-case`，否则 `regression-lock`。校验只负责拒绝不合法结果，不要再信任模型原来的 `flowId`。
- `emit`：不重算 `flowId`。它必须符合 `/^flow_[a-f0-9]{10}$/`，并且等于 `fileStem`。否则退出码 2。
- `unresolved` 非空 → 退出码 2。
- `initialRoute` 必须等于 `routePath[0]`。任何 `initialRoute` 或 `stage.routePattern` 含 `:` → 退出码 2，消息含「具体参数」。
- `stages.length` 必须等于 `routePath.length`。`stages[i].routePattern` 必须等于 `routePath[i]`。`stages[i].stageIndex` 必须等于 `i`。
- `FILL` 和 `SELECT` 必须有 `inputValue`。
- 含 `CLICK`、`CHECK` 或 `SELECT` 的舞台，`network` 非空，或存在 `routeGuard`。否则退出码 2。只有 `FILL` 的舞台可以两条都没有。
- `storageStatePath` 有值时：拒绝绝对路径；`path.resolve(projectRoot, storageStatePath)` 必须仍在 `projectRoot` 内；文件必须已经存在。否则退出码 2。
- 每个 `targetUrlPattern` 必须能 `new RegExp(pattern)`。构造失败则退出码 2。
- `readyRole` 与 `readyName` 必须同时存在或同时没有。
- `assertResponseFields` 的键不合法 → 退出码 2。
- `proseCase` 含「登录」或「storageState」，且 IR 没有 `storageStatePath`，且没有任何 `stage.routePattern` 含 `login`（大小写不敏感）→ 退出码 2，消息里说明缺少登录态。不要把这份失败 IR 写盘。

校验失败抛出的错误对象带数字属性 `exitCode`。不要写 `tests/e2e/generated/`。

## 编译

`compileIntent` 在 `src/idt/core/ir-compiler.ts`。模型通过参数注入，测试不准走网络：

```ts
export interface ModelClient {
  complete(request: {
    system: string;
    messages: Array<{ role: 'user'; content: string }>;
    temperature: 0;
    responseFormat: 'json_object';
  }): Promise<string>;
}
```

导出常量 `IR_SYSTEM_PROMPT`。内容要求模型只输出 JSON；role、name、HTTP 方法、URL、状态码、字段必须来自切片或散文；做不到的写进 `unresolved`，不要编造动作。

`compileIntent({ projectRoot, intent, proseCase, model, force })`：

1. 调用已有的 `extractProjectTopology(projectRoot)`，再 `readSemanticIndex`。
2. `findRoutePath`。寻径失败则原样抛出，不写 `tests/e2e/generated`，也不写 `.idt/last-compile-error.json`。
3. 用户消息是 JSON 字符串，字段为 `intent`、`proseCase`（没有则 `null`）、`proseCaseTruncated`、`routeFlow`、`slices`。`proseCase` 超过 4000 个字符时截断到 4000，并把 `proseCaseTruncated` 设为 `true`。
4. `slices` 来自路径上每个节点的 `transitions[].codeSlice`，按节点顺序。发送前做脱敏：`sk-` 后接至少 8 位字母数字、`Bearer ` 后的令牌、`AKIA` 后 16 位大写或数字，换成 `[REDACTED]`。原文不得出现在发给模型的消息里。
5. 第一次调用 `temperature: 0`、`responseFormat: 'json_object'`。返回体必须是 JSON，且通过 `StateTransitionIRSchema`。失败时把解析或 Zod 错误文本作为下一条 user 消息再调用一次，温度仍是 0。第二次仍失败：把模型最后一次原文写入 `.idt/last-compile-error.json`（先写 `.tmp` 再 rename），抛出 `exitCode === 1`。此时 `tests/e2e/generated/` 下不得新增或改写 `.ir.json` 和 `.spec.ts`。
6. 通过 schema 后，覆盖 `flowId` 与 `oracle`，再 `validateIr(..., { mode: 'gen', routePath })`。校验失败退出码 2，不写 generated，也不把失败当成模型原文去写 `last-compile-error.json`。
7. 成功时只写 `tests/e2e/generated/<flowId>.ir.json`（`.tmp` 再 rename）。不要写 `.spec.ts`。装配器是阶段 3。
8. 目标 `.ir.json` 或同名 `.spec.ts` 已存在且没有 `force` 时，退出码 2，不覆盖已有文件。

`src/idt/core/openai-client.ts` 用全局 `fetch` 调 `${OPENAI_BASE_URL}/chat/completions`。缺省 base URL 为 `https://api.openai.com/v1`。请求体 `temperature` 为 0，`response_format` 为 `{ type: 'json_object' }`，`model` 来自 `IDT_MODEL_NAME`，缺省 `gpt-4o`。不要在单元测试里访问真实网络。用注入的 `fetch` 实现检查请求体即可。

## CLI

`scripts/idt/cli.ts` 增加 `gen <intent>`，选项 `--case <file>`、`--force`、`--yes`。

- `--case` 指向的文件不存在：退出码 2。
- 未设置 `OPENAI_API_KEY`：退出码 2，消息含 `OPENAI_API_KEY`。不要发请求。
- `--yes` 在本阶段不得启动浏览器或 Playwright。可以在成功写出 IR 后打印一行说明执行测试属于后续阶段。
- `sync` 的行为保持阶段 1。

更新 `README.md`，仍然短。写明阶段 2 增加了寻径和 IR 编译，`pnpm idt` 需要 `OPENAI_API_KEY`，单测不访问网络。

## 测试必须覆盖

寻径夹具继续用临时目录和 `extractProjectTopology`，不要把页面提交到 `src/pages`。

1. 三页夹具（去结算 → 立即支付并 `navigate('/checkout/success')` → 文本「支付成功」）。意图「购物车去结算并支付成功」的 `routePath` 正好是 `['/cart', '/checkout', '/checkout/success']`。
2. 意图「完全不存在的黑话zzzz」抛出 `exitCode === 2`，消息含 `idt:sync`。
3. 两个页面都有文案且意图能命中，但没有跳转边。错误 `exitCode === 2`，消息含这两个路径。
4. 只有一个页面被命中时，`routePath.length === 1`。
5. 手写拓扑：`/start` 同时指向 `/b` 和 `/a`，二者都指向 `/end`。关键词下标使起点是 `/start`、终点是 `/end`。`routePath` 必须是 `['/start', '/a', '/end']`。
6. 手写拓扑：边的 `targetRoute` 是 `/goods/1`，路由表里只有 `/goods/:id`。BFS 能走到 `/goods/:id`。
7. `flowIdFromIntent('购物车')` 连续两次相同；`flowIdFromIntent('AA')` 等于 `flowIdFromIntent('aa')`；`flowIdFromIntent('a  b')` 等于 `flowIdFromIntent('a b')`；不同中文意图 id 不同。
8. 模型第一次返回非法 JSON，第二次返回合法且能通过校验的 IR。`complete` 被调用两次，写出的 `flowId` 等于 `flowIdFromIntent(intent)`，不等于模型伪造的 `flow_0123456789`。磁盘上没有 `.spec.ts`。
9. 模型两次都返回 `not-json`。`exitCode === 1`，`.idt/last-compile-error.json` 含原文，`tests/e2e/generated` 里没有新的 `.ir.json` 或 `.spec.ts`。
10. 模型返回的 IR 合法，但 `unresolved` 为 `['需要登录']`。`exitCode === 2`，不写 IR。
11. 模型返回的舞台是 `CLICK`，`network` 为空且没有 `routeGuard`。`exitCode === 2`，不写 IR。
12. 散文含「请先登录」，路径上没有 `login`，也没有 `storageStatePath`。`exitCode === 2`。
13. `storageStatePath` 为 `../outside.json` 时退出码 2。仓库内已存在的相对路径可以通过这一条校验。
14. 切片里含 `sk-abcdefghijklmnopqrstuvwxyz`。发给模型的消息含 `[REDACTED]`，不含这串原文。
15. 已有同名 `.ir.json` 时再次编译，没有 `force` 则退出码 2，文件内容不变。
16. `emit` 模式下 `fileStem` 与 `flowId` 不一致时退出码 2。
17. 注入的 `fetch` 收到的聊天请求里 `temperature` 是 0，`response_format.type` 是 `json_object`。不要访问外网。
18. 不设置 `OPENAI_API_KEY` 时执行 `gen`，退出码 2，stdout/stderr 含 `OPENAI_API_KEY`。

跑 `pnpm test:idt`。失败就改实现。不要删掉或放宽阶段 1 的断言。
