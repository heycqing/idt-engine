# IDT Engine 阶段 5

本项目为 IDT 引擎的阶段 5 实现，将 `gen` 装配到 spec 生成，并补齐了 Playwright 配置。GitHub Actions 工作流写在本地 `.github/workflows/idt-e2e.yml`，这次不推送。单测不访问网络，也不启动浏览器。

系统规范与设计文档请参考：`D:\mine-prop\过去的知识图谱\AI与智能体工程\IDT引擎`。

## 可用命令

- 生成状态转移 IR 与 spec：`pnpm idt "<intent>"`（需要设置环境变量 `OPENAI_API_KEY`；`gen` 会同时写出 IR 与 spec，带 `--yes` 才会执行这条 spec）
- 从 IR 写出 spec：`pnpm idt:emit <ir路径>`（不需要安装 Playwright）
- 自愈失败 spec：`pnpm idt:heal <spec路径>`
- 同步拓扑与语义索引：`pnpm idt:sync`
- 运行端到端测试：`pnpm test:e2e`
- 运行单元测试套件：`pnpm test:idt`（单测不访问网络，也不启动浏览器）
