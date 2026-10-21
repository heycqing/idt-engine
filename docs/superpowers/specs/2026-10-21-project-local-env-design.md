# IDT 项目就近配置设计

## 目标

让每个 IDT 宿主项目使用自己的模型密钥、兼容接口地址和模型名称，不依赖用户级或系统级环境变量。配置跟随项目目录，但密钥文件不进入 Git。

## 配置文件

每个宿主项目根目录使用：

```text
.env.idt.local
```

支持三个字段：

```dotenv
OPENAI_API_KEY=project-key
OPENAI_BASE_URL=https://example.com/v1
IDT_MODEL_NAME=example-model
```

接入脚本同时生成可提交的模板：

```text
.env.idt.example
```

模板只包含空值和说明，不包含任何真实凭据。

## 就近原则

CLI 从当前工作目录开始向上查找最近的 `idt.config.ts`。找到后，该文件所在目录就是 IDT 项目根目录；模型配置只从这个根目录读取。

读取优先级从高到低为：

1. 最近项目根目录的 `.env.idt.local`；
2. 当前进程中的 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`IDT_MODEL_NAME`，用于 CI 或临时兼容；
3. 引擎默认的接口地址和模型名称。

项目本地文件覆盖全局环境变量，保证多个项目即使在同一台机器上也能使用不同的 API Key。

如果向上没有找到 `idt.config.ts`，保持现有行为：以当前工作目录为项目根目录，只使用进程环境变量和默认值。

## 解析规则

不新增 `dotenv` 依赖。使用一个小型、只读解析器，支持：

- 空行和以 `#` 开头的注释；
- `KEY=VALUE`；
- 单引号或双引号包裹的值；
- UTF-8 BOM；
- 值中保留第一个 `=` 之后的字符；
- Windows 和 Unix 换行。

不支持变量展开、命令替换、`export KEY=...` 或执行任意代码。未知字段忽略。

## 安全边界

- `.env.idt.local` 自动加入宿主 `.gitignore`；
- CLI 不打印密钥和值；
- 成功时只允许提示配置来源文件的相对名称；
- 错误信息不得包含配置值；
- `.env.idt.example` 永远只写空值；
- 模型密钥只传给 `OpenAiClient`，不写入 IR、spec、拓扑、报告或 `.idt` 目录；
- `sync`、`emit`、`heal` 不要求模型配置。

## 架构

新增 `src/idt/config/project-env.ts`，提供：

```ts
export interface IdtProjectEnv {
  projectRoot: string;
  sourcePath: string | null;
  openAiApiKey: string;
  openAiBaseUrl?: string;
  modelName?: string;
}

export function findIdtProjectRoot(startDir: string): string;
export function loadIdtProjectEnv(
  startDir: string,
  processEnv?: NodeJS.ProcessEnv,
): IdtProjectEnv;
```

`scripts/idt/cli.ts` 在解析命令后加载一次项目配置：

- `gen` 使用返回的项目根目录、Key、Base URL 和模型名；
- `sync`、`emit`、`heal` 使用同一个就近项目根目录，但不校验 Key；
- `gen` 缺少 Key 时退出码仍为 `2`，消息同时说明可创建 `.env.idt.local`；
- `OpenAiClient` 继续支持显式构造参数，便于测试和库调用。

## 接入行为

`scripts/idt/link-host.mjs`：

- 向 `.gitignore` 追加 `.env.idt.local`，保持幂等；
- 宿主没有 `.env.idt.example` 时创建模板；
- 已有 `.env.idt.example` 时不覆盖；
- 不创建 `.env.idt.local`，避免生成看似有效的空密钥文件；
- 完成提示改为“复制 `.env.idt.example` 为 `.env.idt.local` 后填写项目配置”。

## 测试策略

严格按 TDD 实施：

1. 最近 `idt.config.ts` 决定项目根目录；
2. 子目录运行 CLI 时读取根目录 `.env.idt.local`；
3. 本地文件覆盖进程环境变量；
4. 没有本地文件时回退进程环境变量；
5. 引号、注释、BOM、等号值正确解析；
6. 未知字段和不支持语法不会执行；
7. `gen` 读取本地 Key 后不再报缺少环境变量；
8. 缺少 Key 时退出码为 `2` 且输出不含任何配置值；
9. `sync`、`emit`、`heal` 不受模型配置影响；
10. 接入脚本幂等追加 `.env.idt.local`，创建但不覆盖 `.env.idt.example`；
11. `pnpm test:idt` 和 `pnpm exec tsc --noEmit` 全部通过。

## 文档

README 改为优先说明项目根目录 `.env.idt.local`，终端环境变量只作为 CI 和兼容回退。示例不得包含看似真实的密钥。

## 完成标准

- 两个不同临时项目能分别读取自己的 Key；
- 从项目子目录运行仍选择最近宿主；
- 项目配置覆盖全局环境变量；
- 密钥文件被 Git 忽略；
- 财达宿主生成 `.env.idt.example`，但不生成或提交真实密钥；
- 全量类型检查与单元测试通过；
- 不提交、不打印、不复制任何真实凭据。
