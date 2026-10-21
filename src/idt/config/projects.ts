import fs from 'node:fs';
import path from 'node:path';
import type { IdtConfig } from '../schemas/config.schema.js';
import { toPosixPath } from '../utils/path.js';

export const DEFAULT_PROJECT_GLOBS = ['apps/*', 'packages/*'];

const PAGE_DIR_GLOBS: Array<[string, string]> = [
  ['src/views', 'src/views/**/*.{tsx,jsx,ts,js,vue}'],
  ['src/credit/views', 'src/credit/views/**/*.{tsx,jsx,ts,js,vue}'],
  ['src/pages', 'src/pages/**/*.{tsx,jsx,ts,js,vue}'],
  ['src/app', 'src/app/**/page.{tsx,jsx}'],
];

const ROUTER_DIR_GLOBS: Array<[string, string]> = [
  ['src/router', 'src/router/**/*.{js,ts}'],
  ['src/credit/router', 'src/credit/router/**/*.{js,ts}'],
];

const LOCALE_CANDIDATES = ['src/locales/zh-CN.json', 'locales/zh-CN.json'];

export class IdtProjectError extends Error {
  exitCode: number = 2;
  constructor(message: string) {
    super(message);
    this.name = 'IdtProjectError';
  }
}

export interface IdtProject {
  /** 项目名。标志里没写就取目录名。 */
  name: string;
  /** 项目根目录绝对路径。globs 与产物都相对它解析。 */
  root: string;
  /** 没有任何标志时退化出来的单项目，根等于 IDT 根目录。 */
  implicit: boolean;
  pageGlobs: string[];
  routerGlobs: string[];
  localeFiles: string[];
  /** 起开发服务器的命令。标志没写就从包名推，包里没有 dev 脚本就没有。 */
  devCommand?: string;
  /** 开发服务器端口，标志没写按 3000。 */
  port: number;
}

export const DEFAULT_PROJECT_PORT = 3000;

interface MarkedPackage {
  marker: Record<string, unknown>;
  packageName: string | null;
  hasDevScript: boolean;
}

function readMarker(pkgPath: string): MarkedPackage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const pkg = raw as Record<string, unknown>;
  const marker = pkg.idt;
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null;

  const scripts = pkg.scripts;
  return {
    marker: marker as Record<string, unknown>,
    packageName: typeof pkg.name === 'string' ? pkg.name : null,
    hasDevScript:
      !!scripts &&
      typeof scripts === 'object' &&
      typeof (scripts as Record<string, unknown>).dev === 'string',
  };
}

function devCommandOf(found: MarkedPackage): string | undefined {
  const declared = found.marker.devCommand;
  if (typeof declared === 'string' && declared.trim().length > 0) return declared.trim();
  if (found.hasDevScript && found.packageName) {
    return `pnpm --filter ${found.packageName} dev`;
  }
  return undefined;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.filter((item): item is string => typeof item === 'string');
  return items.length === value.length ? items : null;
}

function detect(projectRoot: string, table: Array<[string, string]>): string[] {
  return table
    .filter(([dir]) => fs.existsSync(path.join(projectRoot, ...dir.split('/'))))
    .map(([, glob]) => glob);
}

/** projectGlobs 只支持 `<dir>/*` 和 `<dir>` 两种写法，够用且不引入 glob 依赖。 */
function expandProjectGlob(idtRoot: string, glob: string): string[] {
  const clean = toPosixPath(glob).replace(/^\.\//, '').replace(/\/+$/, '');
  if (!clean.endsWith('/*')) {
    const abs = path.resolve(idtRoot, ...clean.split('/'));
    return fs.existsSync(abs) ? [abs] : [];
  }
  const parent = path.resolve(idtRoot, ...clean.slice(0, -2).split('/'));
  if (!fs.existsSync(parent)) return [];
  return fs
    .readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(parent, entry.name))
    .sort();
}

export function resolveProjects(idtRoot: string, config: IdtConfig): IdtProject[] {
  const root = path.resolve(idtRoot);
  const globs = config.projectGlobs?.length ? config.projectGlobs : DEFAULT_PROJECT_GLOBS;

  const seen = new Set<string>();
  const projects: IdtProject[] = [];
  for (const glob of globs) {
    for (const dir of expandProjectGlob(root, glob)) {
      if (seen.has(dir)) continue;
      const found = readMarker(path.join(dir, 'package.json'));
      if (!found) continue;
      seen.add(dir);

      const { marker } = found;
      const declaredName = marker.project;
      const declaredPort = marker.port;
      projects.push({
        name:
          typeof declaredName === 'string' && declaredName.trim().length > 0
            ? declaredName.trim()
            : path.basename(dir),
        root: dir,
        implicit: false,
        pageGlobs: stringArray(marker.pageGlobs) ?? detect(dir, PAGE_DIR_GLOBS),
        routerGlobs: stringArray(marker.routerGlobs) ?? detect(dir, ROUTER_DIR_GLOBS),
        localeFiles:
          stringArray(marker.localeFiles) ??
          LOCALE_CANDIDATES.filter((rel) => fs.existsSync(path.join(dir, ...rel.split('/')))),
        devCommand: devCommandOf(found),
        port:
          typeof declaredPort === 'number' && Number.isInteger(declaredPort)
            ? declaredPort
            : DEFAULT_PROJECT_PORT,
      });
    }
  }

  if (projects.length > 0) {
    return projects.sort((a, b) => a.name.localeCompare(b.name));
  }

  // 没有标志：退化成单项目，行为与引入本机制之前完全一致。
  return [
    {
      name: path.basename(root),
      root,
      implicit: true,
      pageGlobs: config.pageGlobs,
      routerGlobs: config.routerGlobs,
      localeFiles: config.localeFiles,
      devCommand: devCommandOf(readMarker(path.join(root, 'package.json')) ?? {
        marker: {},
        packageName: null,
        hasDevScript: false,
      }),
      port: DEFAULT_PROJECT_PORT,
    },
  ];
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function selectProject(
  projects: IdtProject[],
  hint: { name?: string; cwd: string },
): IdtProject {
  const names = projects.map((project) => project.name).join('、');

  if (hint.name) {
    const hit = projects.find((project) => project.name === hint.name);
    if (hit) return hit;
    throw new IdtProjectError(`没有名为 "${hint.name}" 的 IDT 项目。可选：${names}`);
  }

  const cwd = path.resolve(hint.cwd);
  // 嵌套项目取最深的那个
  const inside = projects
    .filter((project) => isInside(project.root, cwd))
    .sort((a, b) => b.root.length - a.root.length);
  if (inside.length > 0) return inside[0];

  if (projects.length === 1) return projects[0];

  throw new IdtProjectError(
    `当前目录不在任何 IDT 项目里，请用 --project 指定。可选：${names}`,
  );
}
