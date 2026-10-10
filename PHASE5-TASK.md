# 阶段 5 任务（只做这一阶段）

把 `gen` 接到装配器，补上 Playwright 配置、`.gitattributes` 和 GitHub Actions。完成后 `pnpm test:idt` 必须退出码 0。阶段 1 到阶段 4 的测试继续通过，不要改它们的断言，也不要改 `src/idt/core/fixtures/`、`src/idt/core/emitter.ts` 的输出，以及自愈算法。

不要安装 `openai`。不要运行 `playwright install`，不要下载浏览器。不要新增 `pnpm start`、`pnpm dev`、`pnpm build`。这个仓库没有前端服务器，配置文件只按下面的原文写。不要改 `PHASE1-TASK.md`、`PHASE2-TASK.md`、`PHASE3-TASK.md`、`PHASE4-TASK.md`、本文件。不要 git commit。不要修改 `D:\mine-prop\过去的知识图谱`。

`compileIntent` 仍然只写 `.ir.json`，不要在这个函数里写 `.spec.ts`。`src/idt/core/ir-compiler.test.ts` 里「no spec.ts」那条测试必须继续成立。

## 生成并装配

新增 `src/idt/core/generate.ts` 和 `src/idt/core/generate.test.ts`。

```ts
export async function generateFlow(options: {
  projectRoot: string;
  intent: string;
  proseCase?: string;
  model: ModelClient;
  force?: boolean;
  yes?: boolean;
  runSpec?: (specPath: string) => Promise<{ exitCode: number; report: unknown }>;
  log?: (line: string) => void;
}): Promise<{ exitCode: number; specPath: string }>;
```

步骤：

1. 调用已有的 `compileIntent`。它抛出的错误原样抛出，不要写 spec。
2. 用已有的 `emitSpec(ir)` 得到源码。写到 `tests/e2e/generated/<flowId>.spec.ts`。先写 `*.spec.ts.tmp`，目标已存在时先删再 rename，和 `emitIrFile` 一样。spec 内容必须等于 `emitSpec(ir)`，并且只用 `\n`。
3. `log` 缺省是 `console.log`。至少打出这些行：
   - `oracle: regression-lock` 或 `oracle: prose-case`，与 IR 的 `oracle` 一致。
   - 每个舞台一行：`stage <stageIndex> <routePattern>`，按舞台顺序。
   - 一行含 `.spec.ts`。
4. `yes` 不是 true 时，不要调用 `runSpec`，返回 `{ exitCode: 0, specPath }`。
5. `yes` 为 true 时调用 `runSpec(specPath)`。没传入 `runSpec` 时用已有的 `runPlaywrightSpec`。返回的 `exitCode === 0` 时，本函数返回 0。否则返回 `{ exitCode: 1, specPath }`。两种情况下 IR 和 spec 都留在磁盘上，不要删。
6. 不要启动浏览器。测试里的 `runSpec` 必须是注入的假实现。

测试夹具沿用 `src/idt/core/ir-compiler.test.ts` 的三页购物车写法，意图用「购物车去结算并支付成功」。模型用注入对象，不要访问网络。

必须覆盖：

1. 不传 `yes`。`tests/e2e/generated/<flowId>.ir.json` 和同名 `.spec.ts` 都存在。spec 等于 `emitSpec`。`runSpec` 调用次数是 0。返回值 `exitCode` 是 0。日志里有 `oracle: regression-lock`，以及 `stage 0 /cart`、`stage 1 /checkout`、`stage 2 /checkout/success`。
2. 传入散文后，日志里有 `oracle: prose-case`。IR 的 `oracle` 也是 `prose-case`。
3. `yes: true` 且注入的 `runSpec` 返回 `{ exitCode: 0, report: null }`。`runSpec` 收到的路径就是刚写好的 spec，调用次数是 1。返回 0。
4. `yes: true` 且 `runSpec` 返回 `{ exitCode: 1, report: null }`。`generateFlow` 返回 1。两份文件仍在，spec 内容不变。
5. 第一次成功后再调用，不传 `force`。错误的 `exitCode === 2`。第一次写下的 spec 字节不变。
6. 同一个目录传 `force: true` 可以再写一次。spec 仍然等于 `emitSpec`。

## CLI

`scripts/idt/cli.ts` 的 `gen` 改为调用 `generateFlow`。

- 未设置 `OPENAI_API_KEY`：先退出码 2，消息含 `OPENAI_API_KEY`。不要调用模型，不要调用 `runPlaywrightSpec`。`--yes` 也一样。
- `--case` 指向的文件不存在：退出码 2。
- 根命令仍然没有必填位置参数。`gen`、`heal`、`sync`、`emit` 都是子命令。
- `sync`、`emit`、`heal` 的行为保持原样。
- `gen` 成功且没有 `--yes`：进程退出码 0。
- `gen --yes` 且测试失败：进程退出码 1，文件保留。
- 删掉「Executing tests (--yes) is reserved for Phase 4」这句。

`package.json` 增加：

```text
"test:e2e": "playwright test --config=playwright.idt.config.ts"
```

不要改已有依赖版本。

用 `spawnSync` 跑 CLI，必须覆盖：

1. `gen 测试意图 --yes`，环境里 `OPENAI_API_KEY` 为空。退出码 2。stdout 和 stderr 合在一起含 `OPENAI_API_KEY`，不含 `playwright test`。
2. `gen 测试意图 --case <一个不存在的文件>`，设置了任意非空 `OPENAI_API_KEY`。退出码 2。不要真的发网络请求；缺页应当发生在构造模型请求之前。
3. 不带子命令执行 `scripts/idt/cli.ts`。退出码不是 0。输出里不能把某个子命令当成意图去编译。

## Playwright 配置

在仓库根新增 `playwright.idt.config.ts`，内容使用下面这份。`retries` 必须是 `0`。CI 的 `webServer.command` 必须是 `pnpm start`，本地才是 `pnpm dev`。不要出现 `networkidle`、`toHaveScreenshot`、`waitForTimeout`、`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`IDT_MODEL_NAME`。

```ts
import { defineConfig, devices } from '@playwright/test';

const port = 3000;
const baseURL = process.env.IDT_BASE_URL || `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e/generated',
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['html'], ['github']] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'Desktop Chrome', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: process.env.CI ? 'pnpm start' : 'pnpm dev',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
```

测试读这个文件的 UTF-8 文本，断言含 `retries: 0`、`pnpm start`、`pnpm dev`、`only-on-failure`，并且不含上面列出的禁止词。再 `import` 这份配置，断言 `retries === 0`，`testDir` 含 `tests/e2e/generated`。导入时不要把 `process.env.CI` 设成 true，避免模块缓存把本地命令冻成 `pnpm start`。

## GitHub Actions 与换行

新增 `.github/workflows/idt-e2e.yml`，只用 `\n`。作业 `runs-on: ubuntu-latest`，`timeout-minutes: 20`。触发是 `pull_request` 到 `main`、`master`、`release/**`。步骤里要有：

- `pnpm/action-setup`，pnpm 版本写 `10`
- `actions/setup-node`，`node-version: 20`，`cache: pnpm`
- `pnpm install --frozen-lockfile`
- `pnpm exec playwright install --with-deps chromium`
- `pnpm build`
- `pnpm test:e2e`
- 失败时用 `actions/upload-artifact` 上传 `playwright-report/` 和 `test-results/`，`retention-days: 7`

整个文件不准出现 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`IDT_MODEL_NAME`、`npm `、`continue-on-error`。环境只声明 `CI: true`，不要声明别的环境变量。

新增仓库根 `.gitattributes`，内容正好是：

```text
* text=auto eol=lf
*.spec.ts text eol=lf
*.json text eol=lf
*.ts text eol=lf
*.yml text eol=lf
*.png binary
```

`.gitignore` 里已经有 `.idt/`、`test-results/`、`playwright-report/`、`blob-report/` 的话就不要再改。缺了哪行再补上。

测试读这两个文件，断言工作流含 `pnpm test:e2e`、`pnpm start` 不要求出现在 yml 里（它在 Playwright 配置里），yml 含 `timeout-minutes: 20` 和 `frozen-lockfile`，并且不含那三个密钥名。`.gitattributes` 含 `eol=lf` 和 `*.png binary`。两个文件都不含 `\r`。

## 文档

更新 `README.md`，仍然短。写明阶段 5 的四个命令：`pnpm idt`、`pnpm idt:emit`、`pnpm idt:heal`、`pnpm idt:sync`，以及 `pnpm test:e2e`。写明 `gen` 现在会同时写 IR 和 spec，`--yes` 才执行这条 spec。写明工作流文件里没有模型密钥，CI 的服务器命令是 `pnpm start`。写明单测不访问网络，也不启动浏览器。

跑 `pnpm test:idt`。失败就改实现。不要删掉或放宽已有测试。
