import fs from 'node:fs';
import path from 'node:path';
import type { PageElement, RouteTransition } from '../schemas/topology.schema.js';
import { extractVueSfc, scanVueTemplate } from './vue-sfc.js';

/**
 * 页面的跳转大多写在子组件里，不在页面文件本身。财达实测：能提取出字面量
 * 目标的 94 处调用里只有 39% 落在页面文件内，其余在子组件、service 和 utils。
 * 只扫页面文件的话 110 条路由里仅 23 条有出边。
 *
 * 这里顺着页面的 import 往下走一层，把子组件里的跳转归属到页面。
 * 深度 1 实测把有出边的页面从 23 提到 75、边从 33 提到 255，单页最多 9 条；
 * 深度 3 会被 utils、service 这类公共模块污染到 920 条，图近乎全连通。
 */

const EXTS = ['.vue', '.ts', '.js', '.tsx', '.jsx'];

/** 只解析 `@/` 别名和相对路径，第三方包一律不碰。 */
export function resolveImportSpecifier(
  spec: string,
  fromFile: string,
  projectRoot: string,
): string | null {
  let base: string;
  if (spec.startsWith('@/')) {
    base = path.resolve(projectRoot, 'src', ...spec.slice(2).split('/'));
  } else if (spec.startsWith('.')) {
    base = path.resolve(path.dirname(fromFile), ...spec.split('/'));
  } else {
    return null;
  }

  const candidates = [base, ...EXTS.map((e) => base + e)];
  for (const ext of EXTS) candidates.push(path.join(base, `index${ext}`));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

const IMPORT_RE =
  /(?:import\s+[^'"]*?from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;

const NAV_RE = /(?:\$router|router)\s*\.\s*(push|replace)\s*\(/g;

/** 从 `(` 之后抓到配平的第一个实参。 */
function firstArgument(text: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  const out: string[] = [];
  for (let i = start; i < text.length && out.length < 2000; i += 1) {
    const ch = text[i];
    if (quote) {
      out.push(ch);
      if (ch === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out.push(ch);
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break;
      depth -= 1;
    } else if (ch === ',' && depth === 0) break;
    out.push(ch);
  }
  return out.join('').trim();
}

/** 只认字面量目标。变量、模板字符串、`go(-1)` 这类一律放弃，不猜。 */
function literalTarget(arg: string): string | null {
  const flat = arg.replace(/\s+/g, ' ');
  const bare = /^['"]([^'"]+)['"]/.exec(flat);
  if (bare) return bare[1];
  const asPath = /\bpath\s*:\s*['"]([^'"]+)['"]/.exec(flat);
  if (asPath) return asPath[1];
  return null;
}

/** 往前找最近的函数名，用来在模板的 click 映射里查触发文本。 */
function enclosingFunctionName(text: string, callIndex: number): string | null {
  const before = text.slice(0, callIndex);
  const patterns = [
    /(\w+)\s*\([^)]*\)\s*\{[^{}]*$/, // 对象方法 foo() {
    /(\w+)\s*[:=]\s*(?:async\s*)?(?:function)?\s*\([^)]*\)\s*(?:=>)?\s*\{[^{}]*$/,
    /function\s+(\w+)\s*\([^)]*\)\s*\{[^{}]*$/,
  ];
  for (const re of patterns) {
    const m = re.exec(before);
    if (m) return m[1];
  }
  return null;
}

function readSource(file: string): { script: string; template: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { script: '', template: '' };
  }
  if (file.endsWith('.vue')) {
    const sfc = extractVueSfc(raw);
    return { script: sfc.script, template: sfc.template };
  }
  return { script: raw, template: '' };
}

/**
 * 收集 pageFile 的 import 子树（最多 maxDepth 层）里的跳转。
 * pageFiles 里的文件一律跳过——另一个页面的跳转不该算到本页头上。
 */
function walkImports(
  projectRoot: string,
  pageFile: string,
  pageFiles: ReadonlySet<string>,
  maxDepth: number,
  visit: (file: string) => void,
): void {
  const seen = new Set<string>([path.resolve(pageFile)]);
  let frontier: string[] = [path.resolve(pageFile)];

  for (let depth = 0; depth < maxDepth; depth += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      const { script } = readSource(current);
      IMPORT_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = IMPORT_RE.exec(script)) !== null) {
        const resolved = resolveImportSpecifier(m[1], current, projectRoot);
        if (!resolved) continue;
        const abs = path.resolve(resolved);
        if (seen.has(abs) || pageFiles.has(abs)) continue;
        seen.add(abs);
        next.push(abs);
        visit(abs);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
}

export function collectComponentTransitions(
  projectRoot: string,
  pageFile: string,
  pageFiles: ReadonlySet<string>,
  maxDepth = 1,
): RouteTransition[] {
  const byTarget = new Map<string, RouteTransition>();

  walkImports(projectRoot, pageFile, pageFiles, maxDepth, (abs) => {
    const { script, template } = readSource(abs);
    const clicks = template ? scanVueTemplate(template).clicks : new Map();

    NAV_RE.lastIndex = 0;
    let nav: RegExpExecArray | null;
    while ((nav = NAV_RE.exec(script)) !== null) {
      const target = literalTarget(firstArgument(script, nav.index + nav[0].length));
      if (!target || byTarget.has(target)) continue;
      const fnName = enclosingFunctionName(script, nav.index);
      byTarget.set(target, {
        targetRoute: target,
        triggerType: 'CLICK',
        triggerElementText: (fnName && clicks.get(fnName)) || undefined,
        codeSlice: script.slice(
          Math.max(0, nav.index - 200),
          Math.min(script.length, nav.index + 200),
        ),
      });
    }
  });

  return [...byTarget.values()];
}

/**
 * 元素清单同样要跟着 import 走。边有了但入口元素在子组件里的话，模型会
 * 正确地拒绝编造，跨页流程照样编不出来——实测财达 /credit/home 的
 * 「账户管理」入口就是这种情况。
 */
export function collectComponentElements(
  projectRoot: string,
  pageFile: string,
  pageFiles: ReadonlySet<string>,
  maxDepth = 1,
  deferredContainers?: string[],
): PageElement[] {
  const out: PageElement[] = [];
  const indexes = new Map<string, number>();

  walkImports(projectRoot, pageFile, pageFiles, maxDepth, (abs) => {
    const { template } = readSource(abs);
    if (!template) return;
    for (const element of scanVueTemplate(template, { deferredContainers }).elements) {
      const key =
        element.name !== undefined
          ? `${element.role}|${element.name}`
          : `${element.role}| ${element.tag ?? ''}`;
      const existingIndex = indexes.get(key);
      if (existingIndex !== undefined) {
        if (out[existingIndex].deferred && !element.deferred) out[existingIndex] = element;
        continue;
      }
      indexes.set(key, out.length);
      out.push(element);
    }
  });

  return out;
}
