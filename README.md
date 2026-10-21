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

## 可用命令

- 把引擎接到宿主：`pnpm idt:link -- --host <宿主根目录>`
- 生成状态转移 IR 与 spec：`pnpm idt "<intent>"`（需要项目根目录的 `.env.idt.local` 填好 `OPENAI_API_KEY`；`gen` 会同时写出 IR 与 spec，带 `--yes` 才会执行这条 spec）
- 从 IR 写出 spec：`pnpm idt:emit <ir路径>`（不需要安装 Playwright）
- 自愈失败 spec：`pnpm idt:heal <spec路径>`
- 同步拓扑与语义索引：`pnpm idt:sync`
- 运行端到端测试：`pnpm test:e2e`
- 运行单元测试套件：`pnpm test:idt`（单测在 `tests/unit/`，不访问网络，也不启动浏览器）
