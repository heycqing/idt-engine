# 阶段 1 任务（只做这一阶段）

在本仓库实现 IDT 的配置、路径、拓扑提取、语义索引。完成后 `pnpm test:idt` 必须退出码 0。

不要实现寻径、IR、模型调用、装配器、自愈、Playwright、GitHub Actions。不要改本文件。不要 git commit。不要修改 `D:\mine-prop\过去的知识图谱`。

## 依赖与脚本

`package.json`：

- `"idt:sync": "tsx scripts/idt/cli.ts sync"`
- `"test:idt": "tsx scripts/idt/run-unit-tests.ts"`
- devDependencies 只加：`typescript`、`tsx`、`zod@^3.23.0`、`ts-morph@^21`、`@types/node@^22`、`commander@^12`
- 不要安装 `openai`、`playwright`、`cross-spawn`

`tsconfig.json` 使用 strict。`scripts/idt/run-unit-tests.ts` 递归收集 `src/idt/**/*.test.ts` 的绝对路径，执行 `node --import tsx --test <那些路径>`，并把子进程退出码作为自己的退出码。不要把 glob 写进 package.json。

`.gitignore` 忽略 `node_modules/`、`.idt/`、`dist/`。

根目录 `README.md` 用中文写 15 行以内：这是 IDT 阶段 1；规范在 `D:\mine-prop\过去的知识图谱\AI与智能体工程\IDT引擎`；本阶段命令是 `pnpm idt:sync` 与 `pnpm test:idt`。

## 文件

```text
idt.config.ts
scripts/idt/cli.ts
scripts/idt/extract-topology.ts
scripts/idt/run-unit-tests.ts
src/idt/config/load.ts
src/idt/utils/path.ts
src/idt/schemas/config.schema.ts
src/idt/schemas/topology.schema.ts
src/idt/extract/topology.ts
src/idt/utils/path.test.ts
src/idt/extract/topology.test.ts
```

提取逻辑放在 `src/idt/extract/topology.ts` 并导出 `extractProjectTopology(projectRoot: string): ProjectTopology`。`scripts/idt/extract-topology.ts` 只做再导出，避免测试去依赖脚本路径。

## 配置

```ts
export const IdtConfigSchema = z.object({
  pageGlobs: z.array(z.string()).min(1),
  localeFiles: z.array(z.string()).default([]),
});
```

`loadIdtConfig(projectRoot)` 读取 `<projectRoot>/idt.config.ts`（用 tsx 的动态 import，或把配置写成可直接 import 的 ts）。文件不存在时使用：

```ts
{
  pageGlobs: [
    'src/pages/**/*.{tsx,jsx,ts,js}',
    'src/app/**/page.{tsx,jsx}',
    'src/views/**/*.{tsx,jsx,ts,js}',
  ],
  localeFiles: ['src/locales/zh-CN.json', 'locales/zh-CN.json'],
}
```

Zod 失败或文件存在但默认导出不合法：抛出带 `exitCode: 2` 的错误。CLI 捕获后打印消息并以退出码 2 结束。

仓库根的 `idt.config.ts` 写这份缺省值，方便本仓库直接 `pnpm idt:sync`。

## 路径

`toPosixPath` 把分隔符换成 `/`。

`toRoutePattern(projectRoot, filePath)` 必须与下面实现一致，不要改规则：

```ts
import path from 'node:path';

export function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

export function toRoutePattern(projectRoot: string, filePath: string): string | null {
  const relative = toPosixPath(path.relative(projectRoot, filePath));
  if (/(^|\/)(components|__tests__)\//.test(relative)) return null;

  const underPages = /(?:^|\/)(pages|views)\//.test(relative);
  const appPage = relative.match(/(?:^|\/)app\/(?:(.*)\/)?page\.(tsx|jsx)$/);
  if (appPage && !underPages) {
    if (relative.includes('/api/') || relative.includes('/@')) return null;
    const raw = (appPage[1] ?? '').replace(/\/$/, '');
    const segments = raw.split('/').filter(Boolean);
    if (segments.some((seg) => seg.startsWith('[...') || seg.startsWith('[[...'))) return null;
    const body = segments
      .filter((seg) => !/^\(.*\)$/.test(seg))
      .map((seg) => {
        const dynamic = seg.match(/^\[(.+)\]$/);
        return dynamic ? `:${dynamic[1]}` : seg;
      })
      .join('/');
    return body ? `/${body}` : '/';
  }

  if (!underPages) return null;
  const body = relative
    .replace(/^.*?\/(pages|views)\//, '')
    .replace(/\.(tsx|jsx|ts|js)$/, '')
    .replace(/\/index$/, '')
    .replace(/^index$/, '');
  return `/${body}`;
}
```

`dynamicParams` 只收集路由模式里的 `:name`。文件路由 `[id]` 得到 `id`。模板字符串插值没有名字，目标路由里用 `:param`。

## sourceDigest

被 pageGlobs 扫到的文件（含最终没有成为路由的文件），相对 POSIX 路径升序。对每个文件计算 `sha256(路径 UTF-8 + NUL + 文件原始字节)` 的 hex。再把这些 hex 按路径顺序用换行拼起来，对整段做 SHA-256，得到 64 位 hex。摘要不含时间、盘符、绝对路径。`generatedAt` 用 `new Date().toISOString()`，测试不比较它。

写 `.idt/topology.json` 和 `.idt/semantic-index.json` 时先写同目录 `*.tmp`，再 `rename` 覆盖。

## 拓扑提取

`extractProjectTopology`：

1. glob 转 POSIX 后再交给 ts-morph。Windows 上不要把反斜杠放进 glob。
2. `toRoutePattern` 返回 null 的文件不建路由节点，但仍计入 sourceDigest。
3. 收集长度 ≥ 2 的 JSX 文本，以及 JSX 属性上的字符串字面量。trim 后再判断长度。
4. 收集 `t('key')`、`t("key")`、`formatMessage({ id: 'key' })`、`formatMessage({ id: "key" })`。localeFiles 按顺序合并：缺文件跳过；后一个文件覆盖同名键。只解析「值是字符串」或「只嵌套一层、内层值是字符串」的 JSON。查找规则：整键命中字符串则用该字符串；否则若 key 正好分成两段 `a.b` 且 `obj.a.b` 是字符串则用它；否则关键词记为 `i18n:<key>`，语义索引 kind 为 `i18n`。解析成功的中文 kind 也是 `i18n`。
5. 跳转来源：
   - 调用表达式的表达式文本以 `navigate`、`router.push`、`history.push`、`redirect` 结尾，第一个参数是字符串或模板字符串。
   - `Link` / `NavLink` 的 `to` 或 `href` 是字符串或模板字符串。
6. 模板字符串：静态片段保留，每个插值变成 `:param`。`` `/goods/${id}/reviews` `` 记成 `/goods/:param/reviews`。
7. 触发类型：调用位于 `onSubmit` 处理函数内，或该函数被同文件 JSX 的 `onSubmit` 引用，则为 `SUBMIT`。位于 `onClick` 内，或被 `onClick` 引用，或来源是 `Link` / `NavLink`，则为 `CLICK`。其余 `PROGRAMMATIC`。能取到对应 JSX 元素的静态子文本时写入 `triggerElementText`。
8. 切片：跳转所在的函数，以及同文件里被 `onClick` / `onSubmit` 引用的函数。函数体含 `fetch(`、`axios.`、`.request(` 的排在前面。按这个顺序拼接。超过 200 行则截断到 199 行，最后一行是 `/* idt-truncated */`，总行数 ≤ 200。不读取 import 的其他文件。
9. 全部路由登记完后做第二遍。边的目标若是具体路径，且拓扑里恰好一条模式路由能按段匹配（`:id` 匹配一个非空段，段数相同），把 `targetRoute` 改成那条模式路由。零条或多条匹配时保留原字符串。
10. 标题用源文件去掉扩展名的基名。语义索引为每条长度 ≥ 2 的关键词写一条 `{ keyword, route, kind }`。JSX 文本和 JSX 字符串属性 kind 为 `text`。标题 kind 为 `title`。同一个 keyword + route 只留一条（kind 冲突时保留先写入的 text，标题不覆盖已有 text）。

模式匹配：

```ts
function segmentsMatch(pattern: string, concrete: string): boolean {
  const a = pattern.split('/').filter(Boolean);
  const b = concrete.split('/').filter(Boolean);
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg.startsWith(':') || seg === b[i]);
}
```

拓扑 schema：

```ts
export const RouteTransitionSchema = z.object({
  targetRoute: z.string().min(1),
  triggerType: z.enum(['CLICK', 'SUBMIT', 'PROGRAMMATIC']),
  triggerElementText: z.string().optional(),
  codeSlice: z.string(),
});

export const RouteTopologyNodeSchema = z.object({
  path: z.string().min(1),
  filePath: z.string().min(1),
  title: z.string(),
  semanticKeywords: z.array(z.string()),
  dynamicParams: z.array(z.string()),
  transitions: z.array(RouteTransitionSchema),
});

export const ProjectTopologySchema = z.object({
  version: z.literal('1.0.0'),
  generatedAt: z.string(),
  sourceDigest: z.string().length(64),
  routes: z.record(z.string(), RouteTopologyNodeSchema),
});
```

语义索引：

```ts
{
  version: '1.0.0',
  sourceDigest: string, // 与拓扑相同
  entries: Array<{ keyword: string; route: string; kind: 'text' | 'i18n' | 'title' }>
}
```

`filePath` 一律是相对 POSIX 路径，不能含 `\` 或盘符。

导出 `readTopology(projectRoot: string): ProjectTopology`。读取 `.idt/topology.json` 并用 Zod 校验。校验失败则重新提取并写回，再校验一次。第二次仍失败则抛出 `exitCode: 1`。

catch-all 页面（`[...slug]`、`[[...slug]]`）不进拓扑。提取时向 stdout 打一行包含 `catch-all` 的警告。

## CLI

`scripts/idt/cli.ts` 使用 commander。本阶段只注册 `sync`。`pnpm idt:sync` 即 `tsx scripts/idt/cli.ts sync`。

`sync`：以 `process.cwd()` 为 projectRoot，提取并写两份 JSON。成功时 stdout 同时出现 `topology.json` 和 `semantic-index.json`。配置不合法时退出码 2。不要在 sync 里调用大模型。

## 测试

用 `node:test`。夹具写到 `os.tmpdir()` 下的临时目录，测完删除。不要把迷你页面提交到 `src/pages`。

必须覆盖：

1. `toRoutePattern`：`src/pages/cart/index.tsx` → `/cart`；`src/pages/index.tsx` → `/`；`src/app/(shop)/cart/page.tsx` → `/cart`；`src/app/page.tsx` → `/`；`src/app/goods/[id]/page.tsx` → `/goods/:id`；`src/app/docs/[...slug]/page.tsx` → `null`；`src/app/mypage.tsx` → `null`；`src/pages/components/Button.tsx` → `null`；`src/components/Button.tsx` → `null`。
2. 三页夹具：
   - `src/pages/cart/index.tsx`：按钮文本「去结算」，`onClick` 调用 `navigate('/checkout')`。
   - `src/pages/checkout/index.tsx`：按钮「立即支付」，处理函数内 `fetch('/api/orders', { method: 'POST' })` 然后 `navigate('/checkout/success')`。
   - `src/pages/checkout/success/index.tsx`：文本「支付成功」。
   - 路由键正好包含 `/cart`、`/checkout`、`/checkout/success`。
   - `/cart` 有一条到 `/checkout` 的边，`triggerType` 为 `CLICK`，`triggerElementText` 为「去结算」。
   - `/checkout` 有一条到 `/checkout/success` 的边，`triggerType` 为 `CLICK`，切片包含 `fetch(`。
   - 每个 `codeSlice` 行数 ≤ 200。
   - `filePath` 不含 `\`。
   - 连续提取两次，`sourceDigest` 相同。
   - 语义索引含 keyword「去结算」route `/cart`，以及「立即支付」「支付成功」。
   - 写出的两份 JSON 能被各自 schema 解析，且 sourceDigest 一致。
3. 第二遍归一化：`src/pages/goods/[id].tsx` 是模式路由；另一页 `navigate('/goods/1')` 的 `targetRoute` 为 `/goods/:id`，`dynamicParams` 含 `id`。
4. 模板字符串：`` navigate(`/goods/${id}/reviews`) `` 的 `targetRoute` 为 `/goods/:param/reviews`。
5. `<Link to="/checkout">去购物车结算</Link>` 产生 `CLICK` 边，`triggerElementText` 为「去购物车结算」。用这个更长的文案，避免和按钮夹具冲突。
6. i18n：locale `{ "pay": { "now": "马上付" } }`，源码 `t('pay.now')`，关键词含「马上付」，kind 为 `i18n`。不存在的 key 记为 `i18n:missing.key`。
7. 截断：一个处理函数超过 200 行且含 `navigate('/checkout')`，对应 `codeSlice` 行数 ≤ 200，最后一行是 `/* idt-truncated */`。
8. `readTopology`：把 `.idt/topology.json` 写成 `{ "version": "nope" }` 后调用，函数重新提取并写回合法文件。
9. CLI：在夹具目录执行 sync（用 `node --import tsx` 跑本仓库的 `scripts/idt/cli.ts`，`cwd` 为夹具），退出码 0，两个 JSON 文件存在。夹具里放一份非法 `idt.config.ts`（默认导出 `{ pageGlobs: [] }`）时退出码为 2。

跑通 `pnpm install` 和 `pnpm test:idt`。测试失败就改代码，不要改测试去迁就错误实现，除非测试本身和本任务冲突。
