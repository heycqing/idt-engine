# IDT Engine 阶段 5

本项目为 IDT 引擎的阶段 5 实现，将 `gen` 装配到 spec 生成，并补齐了 Playwright 配置。GitHub Actions 工作流写在本地 `.github/workflows/idt-e2e.yml`，这次不推送。单测不访问网络，也不启动浏览器。

系统规范与设计文档请参考：`D:\mine-prop\过去的知识图谱\AI与智能体工程\IDT引擎`。

## 接入宿主

引擎代码留在本仓库，不复制到宿主。在引擎仓库执行一次，就会把命令写进宿主的 `package.json`，并在宿主根目录生成 `idt.config.ts` 和 `playwright.idt.config.ts`。

宿主已经是 Git 仓库时，脚本会把 `https://github.com/heycqing/idt-engine.git` 加为子模块 `idt-engine`。这样宿主换机器后仍然指到这份仓库。不想加子模块时加上 `--no-submodule`，命令会指向你本机的引擎目录。

```powershell
Set-Location "D:\mine-prop\idt-engine"
pnpm idt:link -- --host "D:\宿主仓库根目录"
```

脚本接着安装缺的依赖、执行 `pnpm idt:sync`、安装 Chromium。只想先改文件时加 `--no-install`。

宿主是 monorepo 时加 `--project <相对路径>`，顺手把 IDT 标志写进那个业务方的 `package.json`；标志里的项目名默认取目录名，要改用 `--project-name`。已经有标志的包不会被覆盖。

```powershell
pnpm idt:link -- --host "D:\宿主仓库根目录" --project apps/caida
```

依赖装在宿主的 workspace 根（pnpm 在根目录执行 `add` 需要 `-w`，脚本会自己判断）。`tsx` 依赖 `esbuild` 的 install 脚本放置原生二进制，pnpm 10+ 默认不执行，宿主要在 `pnpm-workspace.yaml` 的 `allowBuilds` 里放行，否则四条 idt 命令都没有可执行文件。

宿主克隆之后需要先 `git submodule update --init`，再 `pnpm install`。

接入后进入宿主根目录。看 `.idt/topology.json`。配置好模型后执行 `pnpm idt "一句意图"`。先不要加 `--yes`。

## 模型配置

模型配置跟着项目走，不依赖用户级或系统级环境变量。接入脚本会在宿主根目录生成模板 `.env.idt.example`，把它复制成 `.env.idt.local` 再填写：

```dotenv
OPENAI_API_KEY=
OPENAI_BASE_URL=
IDT_MODEL_NAME=
```

`.env.idt.local` 已经被写进宿主 `.gitignore`，不要提交，也不要把真实密钥写回 `.env.idt.example`。

CLI 从当前工作目录向上找最近的 `idt.config.ts`，那一层就是项目根目录，只从这个根目录读 `.env.idt.local`。所以在宿主的任意子目录里执行命令都能命中同一份配置；同一台机器上的多个宿主各用各的密钥。

每个字段的取值顺序是：项目根目录的 `.env.idt.local` → 终端环境变量 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`IDT_MODEL_NAME` → 引擎默认值（`https://api.openai.com/v1`、`gpt-4o`）。终端环境变量只留给 CI 和老用法兜底。留空的字段按没填处理，会继续往下一级回退。

只有 `gen` 需要密钥。`sync`、`emit`、`heal` 不读模型配置。缺密钥时 `gen` 退出码是 `2`，提示里只有文件名，不会回显任何配置值。

Vue 2 / Vue Router 宿主可在 `idt.config.ts` 增加 `routerGlobs`。`idt:sync` 会静态解析路由数组、嵌套 `children`、动态导入和跨文件 loader，把页面挂到真实 URL；无法解析的页面仍回退到文件路径路由。

```ts
routerGlobs: [
  'src/router/**/*.{js,ts}',
  'src/credit/router/**/*.{js,ts}',
],
```

## 多项目宿主

一个宿主仓库里可以有多个相互独立的 IDT 项目，比如 monorepo 里的多个券商 App。业务方只在自己的 `package.json` 加一行标志：

```json
{ "idt": { "project": "caida" } }
```

`project` 可省略，默认取目录名。需要时同一个对象里还可以写 `pageGlobs`、`routerGlobs`、`localeFiles` 覆盖自动探测。

`idt.config.ts` 用 `projectGlobs` 指定去哪些目录找标志，默认 `['apps/*', 'packages/*']`。配置和 `.env.idt.local` 全仓只有一份，留在 IDT 根目录——标志不是 `idt.config.ts`，所以向上查找会越过被标记的目录走到根上。

标志里还可以写开发服务器信息，Playwright 配置按这两项生成：

```json
{ "idt": { "project": "caida", "devCommand": "pnpm dev:cd", "port": 8080 } }
```

`devCommand` 不写就按包名推 `pnpm --filter <name> dev`，包里没有 dev 脚本就不生成 `webServer`；`port` 不写按 3000。`IDT_BASE_URL` 和 `IDT_PORT` 仍可临时覆盖。

每个项目的拓扑、语义索引、Playwright 配置和生成的 spec 落在各自的项目根下，互不干扰：

```
apps/caida/.idt/topology.json      apps/caida/.idt/playwright.config.ts
apps/caida/tests/e2e/generated/

apps/yuekai/.idt/...
```

`.idt/playwright.config.ts` 由 `idt:sync` 生成，`testDir` 指向该项目的 `tests/e2e`，生成的 spec 和手写的 fixture、冒烟用例都在内。改它没有意义，下次 sync 会覆盖；要调端口或启动命令改标志。

命令按这个顺序确定作用于哪个项目：显式 `--project <name>` → 当前工作目录所在的项目 → 只有一个项目时取它 → 否则报错并列出可选项。`pnpm idt:sync` 不带选择器时同步全部项目。

`pnpm idt projects` 列出发现到的项目和它们的 globs。

`idt batch` 按路由遍历生成，跳过意图匹配，只挑至少有一个确定名字元素的路由。
宿主对某类路由有准入限制时用 `--exclude` 排掉，省下无谓的模型调用。

**Git Bash 用户注意**：MSYS 会把以 `/` 开头的参数当成路径改写，
`--exclude '/credit'` 到手会变成 `C:/Program Files/Git/credit`。写成
`--exclude=credit` 或 `--exclude=credit,trade/home`，去掉前导斜杠。

一个标志都没有时退化为单项目，项目根就是 IDT 根目录，产物路径和行为与引入本机制之前完全一致。

## Hash 路由

`idt:sync` 会从 `routerGlobs` 命中的文件里识别路由模式：认 `new VueRouter({ mode })`，也认 `createRouter({ history: createWebHashHistory() })`。识别结果写进拓扑顶层的 `router` 字段，`goto` 和 `waitForURL` 据此装配。

`mode` 写成变量或三元就不猜，`base` 只认字符串字面量——运行期才有值的写法（比如 `base: window.webConfig.BASE_URL`）解析不了。这两种情况在标志里写死：

```json
{ "idt": { "project": "caida", "routerMode": "hash", "routerBase": "/trade/" } }
```

IR 本身只存应用路由，不带 `#`。同一条 IR 在宿主从 hash 换成 history 之后仍然成立。

## 可用命令

- 把引擎接到宿主：`pnpm idt:link -- --host <宿主根目录>`
- 生成状态转移 IR 与 spec：`pnpm idt "<intent>"`（需要项目根目录的 `.env.idt.local` 填好 `OPENAI_API_KEY`；`gen` 会同时写出 IR 与 spec，带 `--yes` 才会执行这条 spec）
- 从 IR 写出 spec：`pnpm idt:emit <ir路径>`（不需要安装 Playwright）
- 自愈失败 spec：`pnpm idt:heal <spec路径>`
- 同步拓扑与语义索引：`pnpm idt:sync`（多项目宿主默认同步全部，`--project <name>` 只同步一个）
- 按路由批量生成：`pnpm idt batch [--project <name>] [--limit <n>] [--filter <子串>] [--exclude <子串,子串>]`
- 运行某个项目的端到端测试：`pnpm idt test [spec...] [--project <name>] [playwright 参数]`
- 列出发现到的 IDT 项目：`pnpm idt projects`
- 运行单元测试套件：`pnpm test:idt`（单测在 `tests/unit/`，不访问网络，也不启动浏览器）
