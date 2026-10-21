# Vue Router 真实路由拓扑 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 IDT 从 Vue Router 源码提取真实路由，将财达 Vue 页面映射到真实 URL，并在财达宿主完成一次可审计的 `idt:sync` 验证。

**Architecture:** 新增一个独立的 Vue Router 静态提取器，先建立跨文件组件绑定索引，再递归解析路由对象和 `children`，输出组件绝对路径到真实路由列表的映射。现有拓扑提取器消费该映射；解析不到真实路由的页面继续使用文件路径路由，保证向后兼容。

**Tech Stack:** TypeScript、Node.js、ts-morph、Zod、Node test runner、Vue 2 / Vue Router 3 源码静态分析、pnpm。

## Global Constraints

- 不执行任意 Vue Router 源码，不启动浏览器来完成 `idt:sync`。
- `routerGlobs` 必须可选且缺省为空数组，现有宿主输出不变。
- 保留当前未提交的 Vue SFC 支持和 `.github/workflows/idt-e2e.yml`，不覆盖用户改动。
- 所有生产代码修改按 RED → GREEN → REFACTOR 执行，先观察测试因缺少目标能力而失败。
- 引擎单元测试不访问网络、不启动 Chromium。
- 财达宿主只修改 IDT 接入相关文件；不运行 ZIP、发布、GitLab 写操作。
- 财达仓库不提交、不推送；引擎实现也不自动推送。
- 不读取、打印或写入账号、token、模型密钥、证件号或生产响应样本。
- 本计划完成当前“真实路由对齐和宿主验证”里程碑；Git diff 自动选测、测试数据平台和自动创建 MR 属于后续独立子项目。

---

## File Structure

- `src/idt/schemas/config.schema.ts`：声明可选 `routerGlobs` 配置。
- `src/idt/config/load.ts`：提供 `routerGlobs: []` 默认值。
- `src/idt/extract/vue-router.ts`：只负责读取路由源码并输出组件到真实路由的映射及诊断。
- `src/idt/extract/vue-router.test.ts`：覆盖跨文件 loader、嵌套路由、别名和降级行为。
- `src/idt/extract/topology.ts`：把真实路由映射应用到现有页面语义与跳转提取结果。
- `src/idt/extract/topology.test.ts`：验证拓扑节点使用真实路由且保留页面信息。
- `scripts/idt/link-host.mjs`：宿主存在 Vue Router 目录时生成 `routerGlobs`。
- `src/idt/link-host.test.ts`：验证生成的宿主配置。
- `D:\jz-font-end\fabu\trade-monorepo\idt.config.ts`：配置财达页面和路由源码。
- `D:\jz-font-end\fabu\trade-monorepo\package.json`：由接入脚本增加 IDT 命令，同时保留已有脚本。
- `D:\jz-font-end\fabu\trade-monorepo\playwright.idt.config.ts`：由接入脚本生成宿主 Playwright 配置。

---

### Task 1: 锁定基线和配置契约

**Files:**
- Modify: `src/idt/schemas/config.schema.ts`
- Modify: `src/idt/config/load.ts`
- Modify: `src/idt/config/load.test.ts` if present; otherwise test through `src/idt/extract/topology.test.ts`

**Interfaces:**
- Consumes: existing `IdtConfigSchema` and `DEFAULT_IDT_CONFIG`.
- Produces: `routerGlobs: string[]` in parsed `IdtConfig`, defaulting to `[]`.

- [ ] **Step 1: Capture the current worktree and baseline**

Run:

```powershell
git status --short --branch
pnpm test:idt
```

Expected: current Vue files remain visible as local changes; the baseline suite exits `0` before new router tests are added.

- [ ] **Step 2: Write a failing configuration test**

Add an assertion using a temporary `idt.config.ts`:

```ts
const config = loadIdtConfig(tmp);
assert.deepEqual(config.routerGlobs, ['src/router/**/*.{js,ts}']);
assert.deepEqual(DEFAULT_IDT_CONFIG.routerGlobs, []);
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```powershell
node --import tsx --test src/idt/extract/topology.test.ts
```

Expected: FAIL because `routerGlobs` is stripped by the Zod schema or absent from the default config.

- [ ] **Step 4: Implement the minimal schema and default**

Use this contract:

```ts
export const IdtConfigSchema = z.object({
  pageGlobs: z.array(z.string()).min(1),
  localeFiles: z.array(z.string()).default([]),
  routerGlobs: z.array(z.string()).default([]),
});
```

Add `routerGlobs: []` to `DEFAULT_IDT_CONFIG` and the repository-root example config.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run the same focused command. Expected: PASS.

- [ ] **Step 6: Check only Task 1 changes**

Run:

```powershell
git diff --check -- src/idt/schemas/config.schema.ts src/idt/config/load.ts src/idt/extract/topology.test.ts idt.config.ts
git diff -- src/idt/schemas/config.schema.ts src/idt/config/load.ts src/idt/extract/topology.test.ts idt.config.ts
```

Do not commit or push.

---

### Task 2: 提取 Vue Router 组件与真实路由

**Files:**
- Create: `src/idt/extract/vue-router.ts`
- Create: `src/idt/extract/vue-router.test.ts`

**Interfaces:**
- Consumes: `projectRoot: string`, `routerGlobs: string[]`.
- Produces:

```ts
export interface VueRouterMappingResult {
  routesByComponent: Map<string, string[]>;
  routeRecordCount: number;
  mappedRouteCount: number;
  unresolvedComponents: string[];
}

export function extractVueRouterMappings(
  projectRoot: string,
  routerGlobs: string[],
): VueRouterMappingResult;
```

- [ ] **Step 1: Write a failing top-level route test**

Create a temporary fixture containing:

```js
const Home = createRetryableRouteLoader(() => import('@/views/home'))
export default [{ path: '/home', component: Home }]
```

and `src/views/home/index.vue`. Assert:

```ts
const result = extractVueRouterMappings(root, ['src/router/**/*.{js,ts}']);
assert.deepEqual(result.routesByComponent.get(homePath), ['/home']);
assert.equal(result.routeRecordCount, 1);
assert.equal(result.mappedRouteCount, 1);
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```powershell
node --import tsx --test src/idt/extract/vue-router.test.ts
```

Expected: FAIL because the module or export does not exist.

- [ ] **Step 3: Implement file discovery and direct dynamic import resolution**

Use `ts-morph` with `allowJs: true`, normalize paths with existing `toPosixPath`, and resolve:

```ts
const Home = wrapper(() => import('@/views/home'));
```

Resolve `@/` relative to `<projectRoot>/src`; resolve `./` and `../` relative to the importing file. Try the literal path, `.vue`, `.js`, `.ts`, and `index.vue|js|ts` in a deterministic order.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same test command. Expected: PASS.

- [ ] **Step 5: Write failing nested-route tests**

Use this fixture:

```js
const Shell = () => import('@/views/trade')
const Buy = () => import('@/views/trade/buy')
const Absolute = () => import('@/views/absolute')
export default [{
  path: '/trade',
  component: Shell,
  children: [
    { path: 'buy', component: Buy },
    { path: '/absolute', component: Absolute },
  ],
}]
```

Assert routes `/trade`, `/trade/buy`, and `/absolute` map to their three component files.

- [ ] **Step 6: Run and verify RED for child path composition**

Expected: FAIL specifically on missing `/trade/buy` or `/absolute` mappings.

- [ ] **Step 7: Implement recursive route record parsing**

Add small helpers with these responsibilities:

```ts
function joinRoutePath(parent: string, child: string): string;
function parseRouteRecords(array: ArrayLiteralExpression, parentPath: string): RouteRecord[];
function getStaticString(node: Node | undefined): string | null;
```

Absolute child paths replace the parent. Relative children append with one slash. Normalize duplicate slashes without changing `/:param` segments.

- [ ] **Step 8: Run and verify GREEN**

Expected: all current `vue-router.test.ts` cases pass.

- [ ] **Step 9: Write failing cross-file binding tests**

Use three files:

```js
// tradeLoaders.js
export const loadBuy = wrapper(() => import('@/views/trade/buy'))

// credit/router/index.js
const CreditHome = wrapper(() => import('@/credit/views/home'))
export default [{ path: '/credit/home', component: CreditHome }]

// router/index.js
import creditRoutes from '@/credit/router'
import { loadBuy } from './tradeLoaders'
const TradeBuy = loadBuy
export const routes = [{ path: '/trade/buy', component: TradeBuy }]
export default routes.concat(creditRoutes)
```

Assert `/trade/buy` and `/credit/home` both map correctly. The extractor may parse exported route arrays independently; it does not need to execute `concat`.

- [ ] **Step 10: Run and verify RED for imported bindings**

Expected: FAIL on `/trade/buy` until imported identifiers and local aliases are resolved.

- [ ] **Step 11: Implement import and alias traversal**

Resolve identifiers in this order:

1. local variable initializer;
2. default or named import binding in another matched route module;
3. dynamic import literal inside the resolved initializer.

Maintain a `Set<string>` of `filePath::identifier` keys to stop cycles. Sort files, routes, and unresolved diagnostics before returning.

- [ ] **Step 12: Run focused tests and verify GREEN**

Expected: all direct, nested, absolute, credit, and cross-file cases pass.

- [ ] **Step 13: Add edge-case tests**

Add separate assertions for:

- one component mounted at two routes returns a sorted unique array;
- `component: () => import(dynamicName)` increments `routeRecordCount` but appears in `unresolvedComponents`;
- empty `routerGlobs` returns empty maps and zero counts;
- comments containing fake routes are ignored by AST parsing.

- [ ] **Step 14: Run focused tests and refactor while green**

Keep parsing, path resolution, and route joining in separate functions. Run:

```powershell
node --import tsx --test src/idt/extract/vue-router.test.ts
```

- [ ] **Step 15: Check Task 2 files**

Run:

```powershell
git diff --check -- src/idt/extract/vue-router.ts src/idt/extract/vue-router.test.ts
git diff -- src/idt/extract/vue-router.ts src/idt/extract/vue-router.test.ts
```

Do not commit or push.

---

### Task 3: 将真实路由映射接入拓扑

**Files:**
- Modify: `src/idt/extract/topology.ts`
- Modify: `src/idt/extract/topology.test.ts`

**Interfaces:**
- Consumes: `extractVueRouterMappings(projectRoot, config.routerGlobs)`.
- Produces: `ProjectTopology.routes` keyed by real routes when a page has mappings; existing file-derived route when it does not.

- [ ] **Step 1: Write a failing topology integration test**

Build a temporary project with:

```ts
writeFile(tmp, 'idt.config.ts', `export default {
  pageGlobs: ['src/views/**/*.vue'],
  routerGlobs: ['src/router/**/*.js'],
  localeFiles: [],
}`);
```

Add `/subscribe/home` and `/trade/buy` route records pointing at Vue files whose file-derived routes would be `/subscribe` and `/trade/buy`. Assert:

```ts
assert.equal(topo.routes['/subscribe/home'].filePath, 'src/views/subscribe/index.vue');
assert.equal(topo.routes['/subscribe'], undefined);
assert.ok(topo.routes['/subscribe/home'].semanticKeywords.includes('新股申购'));
```

- [ ] **Step 2: Run topology tests and verify RED**

Run:

```powershell
node --import tsx --test src/idt/extract/topology.test.ts
```

Expected: FAIL because the page is still keyed by `/subscribe`.

- [ ] **Step 3: Apply route expansion before node emission**

For each page item, compute:

```ts
const routePatterns = routerMappings.routesByComponent.get(path.resolve(item.absPath))
  ?? [toRoutePattern(projectRoot, item.absPath)].filter(isString);
```

Emit the same page semantics and transitions once per sorted unique real route. Preserve the existing catch-all exclusion and second-pass transition normalization.

- [ ] **Step 4: Run topology tests and verify GREEN**

Expected: existing React/Next/Vue tests and the new real-route test pass.

- [ ] **Step 5: Write a failing diagnostics test**

Capture `console.log` and assert a stable line containing:

```text
Vue Router: records=2 mapped=1 unresolved=1
```

- [ ] **Step 6: Run and verify RED for diagnostics**

Expected: FAIL because no summary is logged.

- [ ] **Step 7: Add one deterministic summary line**

Log only when `routerGlobs.length > 0`. Do not print source code, environment variables, or unresolved expression contents; only counts.

- [ ] **Step 8: Run topology and router tests**

Run:

```powershell
node --import tsx --test src/idt/extract/vue-router.test.ts src/idt/extract/topology.test.ts
```

Expected: PASS.

- [ ] **Step 9: Check Task 3 changes**

Run `git diff --check` and inspect only `topology.ts` plus its test. Do not commit or push.

---

### Task 4: 让一键接入生成 Vue Router 配置

**Files:**
- Modify: `scripts/idt/link-host.mjs`
- Modify: `src/idt/link-host.test.ts`

**Interfaces:**
- Consumes: detected host directories `src/router`, `apps/*/src/router`, and `apps/*/src/credit/router`.
- Produces: generated `idt.config.ts` with `routerGlobs` while preserving an existing host config.

- [ ] **Step 1: Write a failing link-host test**

Create a host fixture containing `src/views/home/index.vue` and `src/router/index.js`. Assert generated config includes:

```ts
routerGlobs: ['src/router/**/*.{js,ts}'],
```

Also assert an existing `idt.config.ts` remains byte-identical.

- [ ] **Step 2: Run and verify RED**

Run:

```powershell
node --import tsx --test src/idt/link-host.test.ts
```

Expected: FAIL only on missing `routerGlobs` in a newly generated config.

- [ ] **Step 3: Implement router directory detection**

Generate route globs only for directories that exist. Sort and deduplicate them. Do not overwrite an existing config.

- [ ] **Step 4: Run and verify GREEN**

Expected: all link-host tests pass.

- [ ] **Step 5: Run the full engine suite**

Run:

```powershell
pnpm test:idt
```

Expected: exit `0`, no network access, no browser launch.

- [ ] **Step 6: Inspect engine changes**

Run:

```powershell
git diff --check
git status --short
git diff --stat
```

Confirm no generated `.idt/`, Playwright report, browser download, lockfile rewrite, or unrelated file appears.

---

### Task 5: 接入财达宿主并验证真实路由覆盖

**Files:**
- Modify: `D:\jz-font-end\fabu\trade-monorepo\idt.config.ts`
- Modify: `D:\jz-font-end\fabu\trade-monorepo\package.json`
- Modify: `D:\jz-font-end\fabu\trade-monorepo\.gitignore`
- Create: `D:\jz-font-end\fabu\trade-monorepo\playwright.idt.config.ts`
- Generated and ignored: `D:\jz-font-end\fabu\trade-monorepo\.idt\topology.json`
- Generated and ignored: `D:\jz-font-end\fabu\trade-monorepo\.idt\semantic-index.json`

**Interfaces:**
- Consumes: local engine through `--no-submodule`; financial app scripts `dev:cd` and `build:cdtest`.
- Produces: host IDT commands, config, Playwright config, and verified topology artifacts.

- [ ] **Step 1: Record host changes before mutation**

Run in the host:

```powershell
git status --short --branch
Get-Content -Raw idt.config.ts
```

Preserve `.sentryclirc.local`, `.superpowers/`, `apps/yichuang/.claude/`, and all pre-existing changes.

- [ ] **Step 2: Update the existing host config explicitly**

Use:

```ts
export default {
  pageGlobs: [
    'apps/caida/src/views/**/*.{vue,js,jsx,ts,tsx}',
    'apps/caida/src/credit/views/**/*.{vue,js,jsx,ts,tsx}',
  ],
  routerGlobs: [
    'apps/caida/src/router/**/*.{js,ts}',
    'apps/caida/src/credit/router/**/*.{js,ts}',
  ],
  localeFiles: [],
};
```

- [ ] **Step 3: Run safe host linking without install or submodule**

Run from the engine repository:

```powershell
pnpm idt:link -- --host 'D:\jz-font-end\fabu\trade-monorepo' --no-submodule --no-install
```

Expected: existing `idt.config.ts` is preserved; IDT scripts and Playwright config are added; no dependency install and no browser download occurs.

- [ ] **Step 4: Run the real host sync**

Run in the host:

```powershell
pnpm idt:sync
```

Expected: exit `0`, a Vue Router count summary, and regenerated `.idt/topology.json`.

- [ ] **Step 5: Verify required real routes**

Read `.idt/topology.json` and assert these keys exist:

```text
/credit/home
/subscribe/home
/trade/buy
/transfer/today
```

Also verify each node's `filePath` points under `apps/caida/src/views` or `apps/caida/src/credit/views`.

- [ ] **Step 6: Measure coverage without changing source**

Use a one-off Node command to count:

- unique static route records in the two route indexes;
- topology routes backed by router mappings;
- unresolved component bindings;
- duplicate component mappings.

Record the four counts in the final handoff. Do not save a generated report file unless the user requests it.

- [ ] **Step 7: Validate host diffs**

Run:

```powershell
git diff --check -- .gitignore package.json idt.config.ts playwright.idt.config.ts
git status --short
git diff -- .gitignore package.json idt.config.ts playwright.idt.config.ts
```

For new text files, run `git diff --no-index --check NUL <file>` and inspect whitespace output. Do not commit or push.

---

### Task 6: 尝试第一条安全真实链路并记录外部阻塞

**Files:**
- Generated and ignored unless explicitly retained: `D:\jz-font-end\fabu\trade-monorepo\tests\e2e\generated\*.ir.json`
- Generated and ignored unless explicitly retained: `D:\jz-font-end\fabu\trade-monorepo\tests\e2e\generated\*.spec.ts`

**Interfaces:**
- Consumes: valid topology, non-empty `OPENAI_API_KEY`, optional `OPENAI_BASE_URL`, optional `IDT_MODEL_NAME`, and a locally runnable财达 environment.
- Produces: one reviewed candidate IR/spec or an exact external blocker report.

- [ ] **Step 1: Check prerequisites without exposing values**

Report only booleans for:

```text
OPENAI_API_KEY set/unset
OPENAI_BASE_URL set/unset
IDT_MODEL_NAME set/unset
storageState file present/absent
```

Do not print environment values or inspect credentials.

- [ ] **Step 2: Select a read-only intent from topology evidence**

Use this intent only if the topology contains a connected path and its transitions have deterministic text:

```text
从新股申购首页进入我的申购页面
```

If no graph edge connects the pages, report the missing transition instead of asking the model to invent it.

- [ ] **Step 3: Generate without execution**

When the model prerequisite exists, run in the host:

```powershell
pnpm idt '从新股申购首页进入我的申购页面'
```

Expected: `.ir.json` and `.spec.ts` are produced; no browser launches because `--yes` is absent.

- [ ] **Step 4: Review the generated contract**

Verify:

- all route patterns exist in `.idt/topology.json`;
- every click has a route guard or network contract;
- no secret, production response, `localhost`, `networkidle`, screenshot oracle, or arbitrary sleep appears;
- generated spec matches `emitSpec` for the IR.

- [ ] **Step 5: Execute only when runtime prerequisites are safe**

Start `pnpm dev:cd` only if the required runtime config is present. Execute with `--yes` only when the test is read-only and a safe login state is available. Otherwise stop with one of these exact blocker categories:

```text
MODEL_CREDENTIAL_MISSING
LOGIN_STATE_MISSING
TEST_ACCOUNT_MISSING
RUNTIME_CONFIG_MISSING
NO_CONNECTED_ROUTE
NETWORK_CONTRACT_MISSING
```

- [ ] **Step 6: Final verification**

Run fresh:

```powershell
pnpm test:idt
git status --short --branch
```

In the host, run:

```powershell
pnpm idt:sync
git status --short --branch
```

Report exact pass/fail counts, real-route coverage counts, files changed in each repository, and any blocker category. Do not claim browser E2E completion unless the command actually ran and exited `0`.

---

## Plan Self-Review

- Spec coverage: configuration, static router extraction, cross-file loaders, nested paths, fallback behavior, diagnostics, host sync, route coverage, safe first flow, and external blockers all have an implementing task.
- Scope: this plan deliberately stops before diff-aware automatic test generation and test-data orchestration; those require separate designs after the first real route and flow are proven.
- Type consistency: `VueRouterMappingResult` and `extractVueRouterMappings()` use the same names in Tasks 2 and 3.
- Mutation safety: both repositories preserve unrelated changes; no destructive Git operation, install, browser download, commit, push, or release command is included.
