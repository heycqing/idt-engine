import fs from 'node:fs';
import path from 'node:path';

export const IDT_CONFIG_FILE = 'idt.config.ts';
export const IDT_ENV_FILE = '.env.idt.local';
export const IDT_ENV_EXAMPLE_FILE = '.env.idt.example';

const RECOGNIZED_KEYS = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'IDT_MODEL_NAME'] as const;
const RECOGNIZED = new Set<string>(RECOGNIZED_KEYS);

export class IdtProjectEnvError extends Error {
  exitCode: number = 2;
  constructor(message: string) {
    super(message);
    this.name = 'IdtProjectEnvError';
  }
}

export interface IdtProjectEnv {
  projectRoot: string;
  sourcePath: string | null;
  openAiApiKey: string;
  openAiBaseUrl?: string;
  modelName?: string;
}

export interface IdtModelCredentials {
  apiKey: string;
  baseUrl?: string;
  modelName?: string;
}

/**
 * 只读解析器。支持注释、空行、引号、BOM、CRLF，值保留第一个 = 之后的字符。
 * 不做变量展开、命令替换，也不认 `export KEY=`，未知字段直接丢掉。
 */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    if (!RECOGNIZED.has(key)) continue;

    let value = line.slice(separator + 1).trim();
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")));
    if (quoted) value = value.slice(1, -1);

    result[key] = value;
  }
  return result;
}

/** 从 startDir 向上找最近的 idt.config.ts；找不到就把 startDir 当项目根。 */
export function findIdtProjectRoot(startDir: string): string {
  const start = path.resolve(startDir);
  let current = start;
  for (;;) {
    if (fs.existsSync(path.join(current, IDT_CONFIG_FILE))) return current;
    const parent = path.dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

export function loadIdtProjectEnv(
  startDir: string,
  processEnv: NodeJS.ProcessEnv = process.env,
): IdtProjectEnv {
  const projectRoot = findIdtProjectRoot(startDir);
  const envPath = path.join(projectRoot, IDT_ENV_FILE);

  let fileValues: Record<string, string> = {};
  if (fs.existsSync(envPath)) {
    let content: string;
    try {
      content = fs.readFileSync(envPath, 'utf8');
    } catch (err: any) {
      throw new IdtProjectEnvError(`无法读取 ${IDT_ENV_FILE}：${err?.code ?? 'read error'}`);
    }
    fileValues = parseEnvFile(content);
  }

  let fromFile = false;
  const pick = (key: (typeof RECOGNIZED_KEYS)[number]): string | undefined => {
    const local = fileValues[key];
    if (local) {
      fromFile = true;
      return local;
    }
    const global = processEnv[key];
    return global ? global : undefined;
  };

  const openAiApiKey = pick('OPENAI_API_KEY');
  const openAiBaseUrl = pick('OPENAI_BASE_URL');
  const modelName = pick('IDT_MODEL_NAME');

  return {
    projectRoot,
    sourcePath: fromFile ? envPath : null,
    openAiApiKey: openAiApiKey ?? '',
    openAiBaseUrl,
    modelName,
  };
}

/** gen 才需要密钥。错误信息只提文件名，不带任何配置值。 */
export function requireModelCredentials(env: IdtProjectEnv): IdtModelCredentials {
  if (!env.openAiApiKey) {
    throw new IdtProjectEnvError(
      `缺少模型密钥。复制 ${IDT_ENV_EXAMPLE_FILE} 为 ${IDT_ENV_FILE}，在项目根目录填写 OPENAI_API_KEY；CI 可继续用同名环境变量。`,
    );
  }
  return {
    apiKey: env.openAiApiKey,
    baseUrl: env.openAiBaseUrl,
    modelName: env.modelName,
  };
}
