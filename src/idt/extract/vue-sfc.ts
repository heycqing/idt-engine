import fs from 'node:fs';
import path from 'node:path';
import { toPosixPath } from '../utils/path.js';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.idt',
  '.idt-virtual',
  'coverage',
  'test-results',
  'playwright-report',
  'blob-report',
]);

export type VueLink = {
  targetRoute: string;
  text?: string;
};

export type ElementRole =
  | 'button'
  | 'link'
  | 'textbox'
  | 'checkbox'
  | 'radio'
  | 'combobox'
  | 'heading'
  | 'tab';

/** 可交互元素候选。name 缺失且 dynamic 为真时，名称要到运行期才定。 */
export type PageElement = {
  role: ElementRole;
  name?: string;
  dynamic?: true;
  tag?: string;
};

export type VueTemplateScan = {
  texts: string[];
  i18nKeys: string[];
  links: VueLink[];
  clicks: Map<string, string | undefined>;
  elements: PageElement[];
};

type Attr = { name: string; value: string | null };
type Frame = {
  name: string;
  kind: 'link' | 'click' | 'other';
  texts: string[];
  target?: string;
  handler?: string;
  attrs: Attr[];
  role?: ElementRole;
  interpolated?: boolean;
};

// 标签到 ARIA role 的映射。宿主换组件库时只改这张表。
const TAG_ROLES: Record<string, ElementRole> = {
  button: 'button',
  'van-button': 'button',
  'router-link': 'link',
  a: 'link',
  textarea: 'textbox',
  'van-field': 'textbox',
  'van-checkbox': 'checkbox',
  'van-switch': 'checkbox',
  'van-radio': 'radio',
  select: 'combobox',
  'van-picker': 'combobox',
  'van-dropdown-item': 'combobox',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  'van-nav-bar': 'heading',
  'van-tab': 'tab',
};

const INPUT_TYPE_ROLES: Record<string, ElementRole> = {
  text: 'textbox',
  number: 'textbox',
  tel: 'textbox',
  password: 'textbox',
  search: 'textbox',
  checkbox: 'checkbox',
  radio: 'radio',
};

const NAME_ATTRS = ['aria-label', 'label', 'placeholder', 'title'];

export function stripVueFromGlob(glob: string): string | null {
  const clean = glob.replace(/^\.\//, '');
  if (!clean.includes('{')) {
    return clean.endsWith('.vue') ? null : clean;
  }
  let removedAll = false;
  const next = clean.replace(/\{([^{}]+)\}/g, (_match, inner: string) => {
    const parts = inner
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== 'vue' && part !== '.vue');
    if (parts.length === 0) {
      removedAll = true;
      return '';
    }
    return parts.length === 1 ? parts[0] : `{${parts.join(',')}}`;
  });
  return removedAll ? null : next;
}

export function extractVueSfc(source: string): { template: string; script: string } {
  const stripped = source.replace(/<!--[\s\S]*?-->/g, '');
  const templates = extractBlocks(stripped, 'template').filter((block) => isTemplateLang(block.attrs));
  const scripts = extractBlocks(stripped, 'script').filter((block) => isScriptLang(block.attrs));
  return {
    template: templates.map((block) => block.body).join('\n'),
    script: scripts.map((block) => block.body).join('\n'),
  };
}

export function scanVueTemplate(template: string): VueTemplateScan {
  const source = template.replace(/<!--[\s\S]*?-->/g, '');
  const texts: string[] = [];
  const i18nKeys = collectI18nKeys(source);
  const links: VueLink[] = [];
  const clicks = new Map<string, string | undefined>();
  const elements: PageElement[] = [];
  const stack: Frame[] = [];
  let i = 0;

  while (i < source.length) {
    if (source[i] !== '<') {
      const start = i;
      while (i < source.length && source[i] !== '<') i += 1;
      const raw = source.slice(start, i);
      if (/\{\{[\s\S]*?\}\}/.test(raw)) {
        for (const frame of stack) frame.interpolated = true;
      }
      const visible = visibleText(raw);
      if (visible) {
        texts.push(visible);
        for (const frame of stack) frame.texts.push(visible);
      }
      continue;
    }

    if (source.startsWith('</', i)) {
      const close = /^<\/([A-Za-z][\w:-]*)\s*>/.exec(source.slice(i));
      if (!close) {
        i += 1;
        continue;
      }
      i += close[0].length;
      const name = close[1].toLowerCase();
      while (stack.length > 0) {
        const frame = stack.pop()!;
        finishFrame(frame, links, clicks, elements);
        if (frame.name === name) break;
      }
      continue;
    }

    const open = matchOpenTag(source, i);
    if (!open) {
      i += 1;
      continue;
    }
    i = open.end;
    const frame = classifyTag(open.name, open.attrs);
    if (open.selfClosing) {
      finishFrame(frame, links, clicks, elements);
    } else {
      stack.push(frame);
    }
  }

  while (stack.length > 0) finishFrame(stack.pop()!, links, clicks, elements);

  return { texts, i18nKeys, links, clicks, elements: dedupeElements(elements) };
}

export function listVueFiles(projectRoot: string, globs: string[]): string[] {
  const found = new Set<string>();
  for (const glob of globs) {
    const clean = toPosixPath(glob).replace(/^\.\//, '');
    if (!globCanMatchVue(clean)) continue;
    const matcher = globToRegExp(clean);
    const prefix = staticDirPrefix(clean);
    const base = prefix ? path.resolve(projectRoot, ...prefix.split('/')) : projectRoot;
    if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) continue;
    walk(base, (abs) => {
      const rel = toPosixPath(path.relative(projectRoot, abs));
      if (matcher.test(rel)) found.add(rel);
    });
  }
  return [...found];
}

export function extractRouteLiteral(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes('${')) return null;
  const quoted = /^(['"`])([\s\S]*)\1$/.exec(trimmed);
  if (quoted) return quoted[2];
  const pathProp = /path\s*:\s*(['"`])([^'"`]*)\1/.exec(trimmed);
  if (pathProp) return pathProp[2];
  if (trimmed.startsWith('/')) return trimmed;
  return null;
}

function extractBlocks(source: string, tag: string): Array<{ attrs: string; body: string }> {
  const re = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const blocks: Array<{ attrs: string; body: string }> = [];
  for (const match of source.matchAll(re)) {
    blocks.push({ attrs: match[1] ?? '', body: match[2] ?? '' });
  }
  return blocks;
}

function langOf(attrs: string): string {
  const match = /\blang\s*=\s*(['"])([^'"]+)\1/i.exec(attrs);
  return match ? match[2].toLowerCase() : '';
}

function isTemplateLang(attrs: string): boolean {
  const lang = langOf(attrs);
  return lang === '' || lang === 'html' || lang === 'htm';
}

function isScriptLang(attrs: string): boolean {
  const lang = langOf(attrs);
  return (
    lang === '' ||
    lang === 'js' ||
    lang === 'jsx' ||
    lang === 'ts' ||
    lang === 'tsx' ||
    lang === 'javascript' ||
    lang === 'typescript'
  );
}

function collectI18nKeys(source: string): string[] {
  const keys: string[] = [];
  for (const match of source.matchAll(/\$t\(\s*(['"])([^'"]+)\1/g)) {
    keys.push(match[2]);
  }
  return keys;
}

function visibleText(raw: string): string | null {
  const visible = raw.replace(/\{\{[\s\S]*?\}\}/g, ' ').replace(/\s+/g, ' ').trim();
  return visible.length >= 2 ? visible : null;
}

function matchOpenTag(
  source: string,
  start: number,
): { name: string; attrs: Attr[]; selfClosing: boolean; end: number } | null {
  const nameMatch = /^<([A-Za-z][\w:-]*)/.exec(source.slice(start));
  if (!nameMatch) return null;
  let j = start + nameMatch[0].length;
  let quote: string | null = null;
  const attrStart = j;
  while (j < source.length) {
    const ch = source[j];
    if (quote) {
      if (ch === quote) quote = null;
      j += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      j += 1;
      continue;
    }
    if (ch === '>') break;
    j += 1;
  }
  if (source[j] !== '>') return null;
  const attrRaw = source.slice(attrStart, j);
  return {
    name: nameMatch[1],
    attrs: parseAttrs(attrRaw),
    selfClosing: /\/\s*$/.test(attrRaw),
    end: j + 1,
  };
}

function parseAttrs(raw: string): Attr[] {
  const attrs: Attr[] = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && /\s/.test(raw[i])) i += 1;
    if (i >= raw.length || raw[i] === '/' || raw[i] === '>') break;
    const nameStart = i;
    while (i < raw.length && /[^\s=/>]/.test(raw[i])) i += 1;
    const name = raw.slice(nameStart, i);
    while (i < raw.length && /\s/.test(raw[i])) i += 1;
    if (raw[i] !== '=') {
      attrs.push({ name, value: null });
      continue;
    }
    i += 1;
    while (i < raw.length && /\s/.test(raw[i])) i += 1;
    let value = '';
    if (raw[i] === '"' || raw[i] === "'") {
      const quote = raw[i];
      i += 1;
      const valueStart = i;
      while (i < raw.length && raw[i] !== quote) i += 1;
      value = raw.slice(valueStart, i);
      if (raw[i] === quote) i += 1;
    } else {
      const valueStart = i;
      while (i < raw.length && !/[\s>/]/.test(raw[i])) i += 1;
      value = raw.slice(valueStart, i);
    }
    attrs.push({ name, value });
  }
  return attrs;
}

const ALLOWED_ROLES = new Set<string>([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'heading',
  'tab',
]);

function isElementRole(value: string): value is ElementRole {
  return ALLOWED_ROLES.has(value);
}

function literalAttr(attrs: Attr[], name: string): string | null {
  const hit = attrs.find((attr) => attr.name.toLowerCase() === name);
  return hit?.value && hit.value.trim().length > 0 ? hit.value.trim() : null;
}

function hasBoundAttr(attrs: Attr[], name: string): boolean {
  return attrs.some((attr) => {
    const lower = attr.name.toLowerCase();
    return lower === `:${name}` || lower === `v-bind:${name}`;
  });
}

function roleOf(tag: string, attrs: Attr[]): ElementRole | undefined {
  const explicit = literalAttr(attrs, 'role');
  if (explicit && isElementRole(explicit)) return explicit;

  if (tag === 'input') {
    const type = (literalAttr(attrs, 'type') ?? 'text').toLowerCase();
    if (type === 'submit' || type === 'button') return 'button';
    return INPUT_TYPE_ROLES[type];
  }

  if (tag === 'a') {
    const linked =
      literalAttr(attrs, 'href') !== null ||
      literalAttr(attrs, 'to') !== null ||
      hasBoundAttr(attrs, 'to') ||
      hasBoundAttr(attrs, 'href');
    return linked ? 'link' : undefined;
  }

  return TAG_ROLES[tag];
}

// 曾经把「带 @click 的 div/span」也算成 button，这是错的：真实无障碍树里它们
// 只是 text，getByRole('button') 永远定位不到，而 heal 只在同 role 内换名字，
// role 错了救不回来。只有真的渲染成 button 的标签和显式 role 才进清单。

/** 名称取值顺序：aria-label → label → placeholder → 帧内可见文本 → title。 */
function elementOf(frame: Frame): PageElement | null {
  if (!frame.role) return null;

  for (const attr of NAME_ATTRS) {
    if (attr === 'title') break;
    const literal = literalAttr(frame.attrs, attr);
    if (literal) return { role: frame.role, name: literal };
    if (hasBoundAttr(frame.attrs, attr)) {
      return { role: frame.role, dynamic: true, tag: frame.name };
    }
  }

  // 帧内出现过插值就不能用可见文本当名字：剥掉 {{ }} 之后剩下的是残句，
  // 比如 "保持在线 {{hours}} 小时" 会变成 "保持在线 小时"，运行期永远匹配不到。
  const text = frame.interpolated ? '' : frame.texts.join(' ').trim();
  if (text.length > 0) return { role: frame.role, name: text };

  const title = literalAttr(frame.attrs, 'title');
  if (title) return { role: frame.role, name: title };
  if (hasBoundAttr(frame.attrs, 'title')) {
    return { role: frame.role, dynamic: true, tag: frame.name };
  }

  return { role: frame.role, dynamic: true, tag: frame.name };
}

function classifyTag(name: string, attrs: Attr[]): Frame {
  const lower = name.toLowerCase();
  const frame: Frame = {
    name: lower,
    kind: 'other',
    texts: [],
    attrs,
    role: roleOf(lower, attrs),
  };
  if (lower === 'router-link') {
    const to = attrs.find((attr) => isToAttr(attr.name));
    const target = to?.value == null ? null : routeFromAttr(to.name, to.value);
    if (target) {
      frame.kind = 'link';
      frame.target = target;
    }
    return frame;
  }
  const click = attrs.find((attr) => isClickAttr(attr.name));
  if (!click?.value) return frame;
  const inline = inlineRoute(click.value);
  const handler = clickHandlerName(click.value);
  if (handler) {
    frame.kind = 'click';
    frame.handler = handler;
  } else if (inline) {
    frame.kind = 'link';
    frame.target = inline;
  }
  return frame;
}

function finishFrame(
  frame: Frame,
  links: VueLink[],
  clicks: Map<string, string | undefined>,
  elements?: PageElement[],
): void {
  const text = frame.texts.join(' ').trim();
  const triggerText = text.length > 0 ? text : undefined;
  if (frame.kind === 'link' && frame.target) {
    links.push({ targetRoute: frame.target, text: triggerText });
  }
  if (frame.kind === 'click' && frame.handler && !clicks.has(frame.handler)) {
    clicks.set(frame.handler, triggerText);
  }
  if (elements) {
    const element = elementOf(frame);
    if (element) elements.push(element);
  }
}

function dedupeElements(elements: PageElement[]): PageElement[] {
  const seen = new Set<string>();
  const out: PageElement[] = [];
  for (const element of elements) {
    const key =
      element.name !== undefined
        ? `${element.role}|${element.name}`
        : `${element.role}| ${element.tag ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(element);
  }
  return out;
}

function isToAttr(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'to' || lower === ':to' || lower === 'v-bind:to';
}

function isClickAttr(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === '@click' || lower.startsWith('@click.') || lower === 'v-on:click' || lower.startsWith('v-on:click.');
}

function routeFromAttr(name: string, value: string): string | null {
  const bound = name.startsWith(':') || name.toLowerCase().startsWith('v-bind:');
  if (!bound) {
    const literal = value.trim();
    if (!literal || literal.includes('${') || !literal.startsWith('/')) return null;
    return literal;
  }
  return extractRouteLiteral(value);
}

function clickHandlerName(expr: string): string | null {
  const trimmed = expr.trim();
  if (/\$router\s*\.\s*(?:push|replace)/.test(trimmed)) return null;
  const match = /^([A-Za-z_$][\w$]*)\s*(?:\(|$)/.exec(trimmed);
  if (!match) return null;
  if (match[1] === '$router' || match[1] === 'router') return null;
  return match[1];
}

function inlineRoute(expr: string): string | null {
  const match = /\$router\s*\.\s*(?:push|replace)\(\s*([\s\S]*?)\s*\)/.exec(expr);
  if (!match) return null;
  return extractRouteLiteral(match[1]);
}

function globCanMatchVue(glob: string): boolean {
  const brace = /\{([^{}]+)\}/.exec(glob);
  if (brace) {
    return brace[1].split(',').some((part) => part.trim() === 'vue' || part.trim() === '.vue');
  }
  return glob.endsWith('.vue') || glob.includes('*.vue');
}

function staticDirPrefix(glob: string): string {
  const idx = glob.search(/[*?{]/);
  const head = idx === -1 ? glob : glob.slice(0, idx);
  const slash = head.lastIndexOf('/');
  return slash === -1 ? '' : head.slice(0, slash);
}

function walk(dir: string, onFile: (abs: string) => void): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), onFile);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.vue')) onFile(path.join(dir, entry.name));
  }
}

function globToRegExp(glob: string): RegExp {
  const sources = expandBraces(glob).map(oneGlobToSource);
  return new RegExp(`^(?:${sources.join('|')})$`);
}

function expandBraces(glob: string): string[] {
  const match = /\{([^{}]+)\}/.exec(glob);
  if (!match) return [glob];
  return match[1]
    .split(',')
    .map((part) => part.trim())
    .flatMap((option) => expandBraces(glob.replace(match[0], option)));
}

function oneGlobToSource(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        out += '(?:[^/]+/)*';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
      continue;
    }
    if (ch === '*') {
      out += '[^/]*';
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    out += /[|\\{}()[\]^$+?.]/.test(ch) ? `\\${ch}` : ch;
  }
  return out;
}
