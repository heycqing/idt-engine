export interface LinkHostOptions {
  hostRoot: string;
  engineRoot: string;
  noInstall?: boolean;
  noSubmodule?: boolean;
  skipBrowsers?: boolean;
  skipSync?: boolean;
  project?: string;
  projectName?: string;
  log?: (line: string) => void;
  run?: (command: string, args: string[], cwd: string) => number;
}

export interface LinkHostResult {
  configWritten: boolean;
  markerWritten: string | null;
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
export function isPnpmWorkspaceRoot(hostRoot: string): boolean;
export function writeProjectMarker(
  hostRoot: string,
  projectRel: string,
  projectName?: string,
): string | null;
export function toPosixRelative(fromDir: string, toDir: string): string;
