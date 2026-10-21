export interface LinkHostOptions {
  hostRoot: string;
  engineRoot: string;
  noInstall?: boolean;
  noSubmodule?: boolean;
  skipBrowsers?: boolean;
  skipSync?: boolean;
  log?: (line: string) => void;
  run?: (command: string, args: string[], cwd: string) => number;
}

export interface LinkHostResult {
  configWritten: boolean;
  playwrightWritten: boolean;
  envExampleWritten: boolean;
  gitignoreAdded: string[];
  installCode: number;
  syncCode: number;
  browserCode: number;
  notes: string[];
}

export function detectPageGlobs(hostRoot: string): {
  pageGlobs: string[];
  usedDefaults: boolean;
};

export function detectRouterGlobs(hostRoot: string): string[];
export function desiredScripts(enginePosix: string, tsxRuntimePosix?: string): Record<string, string>;
export function linkHost(options: LinkHostOptions): LinkHostResult;
export function mergeGitignore(existing?: string): { text: string; added: string[] };
export function renderEnvExample(): string;
export function renderPlaywrightConfig(localCommand: string): string;
export function toPosixRelative(fromDir: string, toDir: string): string;
