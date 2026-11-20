import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import {
  DEFAULT_DEFERRED_CONTAINERS,
  IdtConfigSchema,
  type IdtConfig,
} from '../schemas/config.schema.js';

export const DEFAULT_IDT_CONFIG: IdtConfig = {
  pageGlobs: [
    'src/pages/**/*.{tsx,jsx,ts,js,vue}',
    'src/app/**/page.{tsx,jsx}',
    'src/views/**/*.{tsx,jsx,ts,js,vue}',
  ],
  localeFiles: ['src/locales/zh-CN.json', 'locales/zh-CN.json'],
  routerGlobs: [],
  deferredContainers: DEFAULT_DEFERRED_CONTAINERS,
  verifyWarningExceptions: [],
};

export class IdtConfigError extends Error {
  exitCode: number = 2;
  constructor(message: string) {
    super(message);
    this.name = 'IdtConfigError';
  }
}

export function loadIdtConfig(projectRoot: string): IdtConfig {
  const configPath = path.resolve(projectRoot, 'idt.config.ts');
  if (!fs.existsSync(configPath)) {
    return DEFAULT_IDT_CONFIG;
  }

  let rawConfig: unknown;
  try {
    const fileContent = fs.readFileSync(configPath, 'utf8');
    const transpiled = ts.transpileModule(fileContent, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText;

    const moduleObj = { exports: {} as any };
    const req = createRequire(configPath);
    const sandbox = {
      exports: moduleObj.exports,
      module: moduleObj,
      require: req,
      console,
      process,
    };
    vm.createContext(sandbox);
    vm.runInContext(transpiled, sandbox);

    rawConfig = moduleObj.exports.default !== undefined
      ? moduleObj.exports.default
      : moduleObj.exports;
  } catch (err: any) {
    if (err instanceof IdtConfigError) {
      throw err;
    }
    const error = new IdtConfigError(`Failed to load config at ${configPath}: ${err?.message ?? err}`);
    throw error;
  }

  const parsed = IdtConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    const error = new IdtConfigError(`Invalid IDT config: ${parsed.error.message}`);
    throw error;
  }

  return {
    ...parsed.data,
    deferredContainers: parsed.data.deferredContainers ?? DEFAULT_DEFERRED_CONTAINERS,
  };
}
