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

接入后进入宿主根目录。看 `.idt/topology.json`。设置 `OPENAI_API_KEY` 后执行 `pnpm idt "一句意图"`。先不要加 `--yes`。

## 可用命令

- 把引擎接到宿主：`pnpm idt:link -- --host <宿主根目录>`
- 生成状态转移 IR 与 spec：`pnpm idt "<intent>"`（需要设置环境变量 `OPENAI_API_KEY`；`gen` 会同时写出 IR 与 spec，带 `--yes` 才会执行这条 spec）
- 从 IR 写出 spec：`pnpm idt:emit <ir路径>`（不需要安装 Playwright）
- 自愈失败 spec：`pnpm idt:heal <spec路径>`
- 同步拓扑与语义索引：`pnpm idt:sync`
- 运行端到端测试：`pnpm test:e2e`
- 运行单元测试套件：`pnpm test:idt`（单测不访问网络，也不启动浏览器）
