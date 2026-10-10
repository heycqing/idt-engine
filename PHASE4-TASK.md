# 阶段 4 任务（只做这一阶段）

在现有代码上实现子进程执行、失败定位、重放步骤和自愈。完成后 `pnpm test:idt` 必须退出码 0。阶段 1 到阶段 3 的测试继续通过，不要改它们的断言，也不要改 `src/idt/core/fixtures/` 和 `src/idt/core/emitter.ts` 的输出。

不要实现 `playwright.idt.config.ts`、GitHub Actions、`test:e2e` 脚本。不要运行 `playwright install`，不要下载浏览器。不要安装 `openai`。不要改 `PHASE1-TASK.md`、`PHASE2-TASK.md`、`PHASE3-TASK.md`、本文件。不要 git commit。不要修改 `D:\mine-prop\过去的知识图谱`。

单元测试不准启动 Chromium，不准调用 `chromium.launch`，不准执行 `pnpm exec playwright`。真实浏览器适配器只给 CLI 的默认路径使用，测试必须把跑测试和重放注入进去。

## 依赖与脚本

在 `D:\mine-prop\idt-engine` 执行：

```text
pnpm add -D cross-spawn@^7.0.3 @playwright/test@^1.49.0
```

不要改已有依赖的版本。`package.json` 增加：

```text
"idt:heal": "tsx scripts/idt/cli.ts heal"
```

不要增加 `test:e2e`。

## 新增文件

```text
src/idt/core/similarity.ts
src/idt/core/aria-snapshot.ts
src/idt/core/runner.ts
src/idt/core/replay.ts
src/idt/core/healer.ts
src/idt/core/similarity.test.ts
src/idt/core/aria-snapshot.test.ts
src/idt/core/runner.test.ts
src/idt/core/replay.test.ts
src/idt/core/healer.test.ts
```

可以改 `scripts/idt/cli.ts`、`package.json`、`pnpm-lock.yaml`、`README.md`。`.gitignore` 可以追加这三行，不要删已有条目：

```text
test-results/
playwright-report/
blob-report/
```

## 相似度

`src/idt/core/similarity.ts`：

- `levenshtein(a: string, b: string): number`。插入、删除、替换的代价都是 1。按 UTF-16 码元计算，不要按字节。
- `similarity(a: string, b: string): number` 等于 `1 - levenshtein(a, b) / Math.max(a.length, b.length)`。两边都是空串时返回 `1`。
- `scoreAcceptable(distance: number, maxLen: number): boolean` 用整数比较，避免 0.72 的二进制误差：`maxLen > 0 && distance * 100 <= maxLen * 28`。这就是「相似度大于或等于 0.72」。`maxLen === 0` 时，只有 `distance === 0` 才返回 true。
- `chooseReplacement(currentName: string, names: string[]): { ok: true; name: string } | { ok: false; reason: 'low' | 'gap' | 'empty' }`
  - 先把 `names` 去重。
  - 没有候选：`empty`。
  - 每个候选对 `currentName` 算 `similarity`。按分数从高到低，分数相同再按 `localeCompare`。
  - 最高分用 `scoreAcceptable(levenshtein(currentName, best), Math.max(currentName.length, best.length))` 判断。不通过则 `low`。
  - 候选至少两个，且第二名的相似度 `> 最高分 - 0.05`：`gap`。分差正好是 0.05 时允许替换。
  - 否则 `{ ok: true, name: 最高分的名字 }`。只有一个候选且达到 0.72 时替换。不要设中文候补词表。

必须覆盖的纯函数结果：

1. `similarity('abcd', 'abcd') === 1`，`similarity('', '') === 1`，`similarity('a', '') === 0`。
2. `similarity('abcd', 'abXd') === 0.75`。`scoreAcceptable(1, 4)` 为 true。`scoreAcceptable(1, 3)` 为 false。`scoreAcceptable(7, 25)` 为 true。`scoreAcceptable(8, 25)` 为 false。
3. `chooseReplacement('abcd', ['abXd'])` 得到 `abXd`。
4. `chooseReplacement('abc', ['abX'])` 的 reason 是 `low`。
5. `chooseReplacement('aaaaaaaa', ['aaaaaaab', 'aaaaaabb'])` 得到 `aaaaaaab`。这里第一名 0.875，第二名 0.75，分差 0.125。
6. `chooseReplacement('aaaaaaaa', ['aaaaaaab', 'aaaaaaac'])` 的 reason 是 `gap`。两个候选编辑距离都是 1。
7. `chooseReplacement('abcd', [])` 的 reason 是 `empty`。

## 无障碍快照

`parseAriaSnapshot(snapshot: string): Array<{ role: string; name: string }>`。

逐行看。忽略没有引号名字的行，例如 `- navigation:`。能匹配的行形如 `- button "确认去结账订单"`，行首可以有空格，行尾可以有 ` [level=1]` 或 ` [checked=true]`。role 是 `-` 后面的第一段连续英文字母。name 是同一行第一对双引号里的内容，支持 `\"` 和 `\\`。不要用候补词表。

`- button "他说\"好\""` 解析出的 name 是 `他说"好"`。

## 子进程

`runCommand(command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv })` 返回 `Promise<{ exitCode: number; stdout: string; stderr: string }>`。

- 使用 `cross-spawn`。`args` 保持数组，不要拼成一条命令字符串。
- `shell` 只有在 `process.platform === 'win32'` 时为 true。
- 环境是 `{ ...process.env, ...options.env, FORCE_COLOR: '0' }`。调用方传入的 `FORCE_COLOR` 也要被覆盖成 `0`。
- stdout 和 stderr 分开累积。
- 子进程 `code === null` 时，`exitCode` 记为 1。

测试用 `process.execPath` 和 `['-e', ...]` 跑一段 Node：stdout 写 `out`，stderr 写 `err`，`process.exit(3)`。断言退出码 3、stdout 含 `out`、stderr 含 `err`、stdout 不含 `err`。再跑一段把 `process.env.FORCE_COLOR` 打到 stdout，断言得到的是 `0`。

`playwrightTestInvocation(specPath: string)` 返回：

```ts
{ command: 'pnpm', args: ['exec', 'playwright', 'test', specPath, '--config=playwright.idt.config.ts', '--reporter=json'] }
```

`command` 必须是 `pnpm`。args 里不准出现 `npm`。

`runPlaywrightSpec(specPath, projectRoot, spawnImpl?)`：

- 默认 `spawnImpl` 是 `runCommand`。
- `cwd` 是 `projectRoot`。
- 环境在继承之外设置 `PLAYWRIGHT_JSON_OUTPUT_NAME` 为 `.idt/last-report.json`（正斜杠）。
- 先确保 `projectRoot/.idt` 目录存在。
- 调用结束后读取 `projectRoot/.idt/last-report.json`。文件不存在时，返回 `{ exitCode, report: null }`，`exitCode` 仍是子进程的码（null 已按 1 处理）。
- 文件存在则 `JSON.parse`。解析失败时抛出 `exitCode === 2` 的错误。

测试注入 `spawnImpl`，不要真的去跑 Playwright。断言它收到的 command、args、cwd，以及 env 里的 `PLAYWRIGHT_JSON_OUTPUT_NAME` 和 `FORCE_COLOR`。

## 报告与动作定位

`firstFailure(report: unknown): { line: number; message: string } | null`。

递归遍历 `suites`（含嵌套 `suites`）。按出现顺序找第一个 `results[].status` 是 `failed` 或 `timedOut` 的结果。`passed`、`skipped` 跳过。取该结果里第一个带 `location.line` 的 error。`message` 是这些 error 的 `message` 拼起来。找不到失败则返回 null。

`locateHealTarget(specSource: string, ir: StateTransitionIR, failure: { line: number; message: string })`。

以下情况抛出 `exitCode === 2`：

- `message` 不含 `Timeout`。
- `failure.line` 对应的那一行（1-based）不含 `getByRole(`。
- 这一行解析不出唯一一对 role 和 name。解析规则与装配器一致：`getByRole("button", { name: "确认去结算订单" })`，两段引号字符串用 `JSON.parse`。
- IR 里按下面的发射顺序，找不到 `targetRole` 和 `targetName` 都相等的动作，或者找到多于一个。

发射顺序和 `emitter.ts` 相同，不要改装配器：每个舞台里，先是 `triggersRequest !== true` 的动作并保持原相对顺序；若至少有一个 `triggersRequest === true`，最后一个这样的动作是触发动作，否则最后一个动作是触发动作。触发动作排在该舞台其余动作之后。路由守卫的 `getByRole` 不是动作。对不上动作就拒绝，不要去改 `readyName`。

返回 `{ stageIndex: number; actionIndex: number; role: string; name: string }`。`actionIndex` 是该动作在原始 `stage.actions` 数组里的下标，不是发射顺序下标。

## 重放

`replay.ts` 导出：

```ts
export interface ReplayPage {
  goto(url: string): Promise<void>;
  click(role: string, name: string, timeoutMs: number): Promise<void>;
  fill(role: string, name: string, value: string, timeoutMs: number): Promise<void>;
  check(role: string, name: string, timeoutMs: number): Promise<void>;
  selectOption(role: string, name: string, value: string, timeoutMs: number): Promise<void>;
  waitForURL(pattern: string, timeoutMs: number): Promise<void>;
  ariaSnapshot(): Promise<string>;
}

export async function replayUntil(
  ir: StateTransitionIR,
  target: { stageIndex: number; actionIndex: number },
  page: ReplayPage,
): Promise<string>;
```

步骤：

1. `page.goto(ir.initialRoute)`。不要写主机名。
2. 按发射顺序执行失败动作之前的动作。失败动作本身不执行。
3. 一个舞台的全部动作都已经在失败动作之前时，如果该舞台有 `routeGuard`，调用 `page.waitForURL(guard.targetUrlPattern, timeout)`。timeout 用该舞台触发动作的 `timeoutMs`，没有动作时用 5000。不要点击 `readyRole`。不要等待网络，不要调用 `waitForResponse`。
4. 失败动作所在舞台的路由守卫不执行。
5. 返回 `page.ariaSnapshot()`。
6. 这个函数不准写文件，不准拼出另一份 spec。

另外导出 `launchChromiumReplay(projectRoot, storageStatePath, run: (page: ReplayPage) => Promise<string>)`。只有 CLI 默认路径可以调用它。

- `chromium.launch({ headless: true })`。
- `browser.newContext` 的 `baseURL` 来自 `IDT_BASE_URL`，没有则是 `http://127.0.0.1:3000`。
- `storageStatePath` 有值时传 `path.resolve(projectRoot, storageStatePath)`，没有则不要传 `storageState`。
- 用 `page.getByRole(role, { name }).click/fill/check/selectOption`，timeout 用动作上的 `timeoutMs`。
- `waitForURL` 使用 `new RegExp(pattern)`。
- 快照是 `page.locator('body').ariaSnapshot()`。
- `finally` 里 `browser.close()`。

测试用一个记录调用的假 `ReplayPage`，覆盖：

1. 失败动作是舞台 0 的触发 `CLICK`，它前面还有 `FILL` 和 `CHECK`。调用顺序是 `goto`、`fill`、`check`、`ariaSnapshot`。没有 `click`，没有 `waitForURL`。
2. 失败动作是舞台 1 的第一个动作。舞台 0 有一个 `CLICK` 和一个 `routeGuard`。调用顺序含舞台 0 的 `click`、`waitForURL`，然后才是 `ariaSnapshot`。舞台 1 的动作没有执行。

## 自愈

`heal(options: { projectRoot: string; specPath: string; runSpec?: ...; replay?: ... }): Promise<{ exitCode: number }>`。

`specPath` 不是绝对路径时相对 `projectRoot`。文件名必须以 `.spec.ts` 结尾。同目录、同一主干的 `.ir.json` 必须存在。spec 或 IR 缺失、名字不对：返回 `{ exitCode: 2 }`，不创建文件。

开始前把两份文件的原始 UTF-8 字节留在内存里。

1. `runSpec(specPath)` 默认实现是 `runPlaywrightSpec`。测试必须传入自己的实现。
2. 退出码 0：返回 `{ exitCode: 0 }`。不调用 replay，不写文件。
3. 用 `firstFailure` 和 `locateHealTarget`。报告缺失、没有失败位置、或定位抛出 2：返回 `{ exitCode: 2 }`，文件字节不变。
4. `replay` 默认使用 `launchChromiumReplay` 再 `replayUntil`。测试传入的 `replay` 直接返回快照字符串。它抛错时返回 `{ exitCode: 2 }`，文件字节不变。
5. `parseAriaSnapshot` 之后只保留 `role === target.role` 的 name，再 `chooseReplacement(target.name, names)`。`ok === false` 时返回 `{ exitCode: 2 }`，文件字节不变。
6. 替换 IR 里该动作的 `targetName`。不要改 role、URL、network、`readyName`。用现有 `emitSpec` 重新装配。先写临时文件再换成正式的 `.ir.json` 和 `.spec.ts`。IR 用 `JSON.stringify(ir, null, 2) + '\n'`。Windows 上目标已存在时，tmp 写完再删除旧文件然后 rename。
7. 再调用一次 `runSpec`。退出码 0：返回 `{ exitCode: 0 }`，磁盘上留下新 IR 和新 spec。新 spec 必须等于 `emitSpec(更新后的 IR)`。
8. 复跑退出码不是 0：把内存里的原始字节写回两个文件，返回 `{ exitCode: 1 }`。
9. 全程 `replay` 最多调用一次，`runSpec` 最多调用两次。不要循环尝试第二个定位器。

`runSpec` 的类型：

```ts
(specPath: string) => Promise<{ exitCode: number; report: unknown }>
```

`replay` 的类型：

```ts
(ir: StateTransitionIR, target: { stageIndex: number; actionIndex: number }) => Promise<string>
```

测试在临时目录里自己写一份合法 IR，并用 `emitSpec` 写出 spec。失败行号从这份 spec 里现找，不要手写一个会漂的行号。按钮文案用 `确认去结算订单`。高相似度候选用 `确认去结账订单`（7 个字里改 1 个，过 0.72）。不要用 `去结算` / `去结账` 这种 3 字差 1 字的例子，那一对的相似度低于 0.72，应当拒绝。

必须覆盖：

1. 第一次 `runSpec` 退出码 0。replay 调用次数是 0。两个文件字节不变。`heal` 返回 0。
2. 报告是 `timedOut`，message 含 `Timeout` 和 `getByRole`，快照里只有 `- button "确认去结账订单"`。返回 0。IR 的该动作 `targetName` 变成 `确认去结账订单`。spec 等于 `emitSpec` 的新结果，并且含 `selectOption` 或 `click` 中对应的那一个调用。`runSpec` 被调用两次，第二次看到的 spec 已经是新文案。replay 被调用一次。
3. 快照里同时有 `确认去结账订单` 和 `确认去结算定单`。返回 2。两个文件字节不变。`runSpec` 只调用一次。
4. 快照里只有一个角色相同、但相似度不够的名字，例如 `完全不同`。返回 2。文件不变。
5. 快照里相似名字的 role 是 `link`，失败动作的 role 是 `button`。返回 2。文件不变。
6. 第一次失败，替换写入成功，第二次 `runSpec` 返回退出码 1。`heal` 返回 1。两个文件恢复成内存中的原始字节。replay 只调用一次。
7. 失败 message 是 `expect(received).toBe(expected)`，不含 `Timeout`。返回 2。文件不变。replay 不被调用。
8. 同目录没有 `.ir.json`。返回 2。
9. `spawnSync` 跑 `scripts/idt/cli.ts heal <不存在的 spec>`。环境变量 `OPENAI_API_KEY` 设成空字符串。退出码 2。进程要自己结束，不要启动浏览器。

## CLI

`scripts/idt/cli.ts` 增加 `heal <spec>`。不需要 `OPENAI_API_KEY`。用默认的 `runPlaywrightSpec` 和 `launchChromiumReplay`。把 `heal()` 的 `exitCode` 作为进程退出码。退出码 2 时错误写到 stderr。退出码 0 且发生过替换时，stdout 含新的 `targetName`。退出码 0 且测试本来就通过时，stdout 含 `already passed`。

`sync`、`gen`、`emit` 保持原样。`gen` 仍然不要写 `.spec.ts`。

更新 `README.md`，仍然短。写明阶段 4 增加了 `pnpm idt:heal <spec路径>`。单测不访问网络，也不启动浏览器。真正的 Playwright 配置和 CI 还没做。

跑 `pnpm test:idt`。失败就改实现。不要删掉或放宽已有测试。
