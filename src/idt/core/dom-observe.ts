import { redactSecrets } from './secret-redaction.js';

export interface ObservedElement {
  tag: string;
  role: string | null;
  ownText: string;
  alt: string | null;
  css: string;
  visible: boolean;
}

/** Returns a self-contained script that evaluates to raw observed elements. */
export function observeScript(): string {
  return `(() => {
    const isStableClass = (name) => {
      if (!name || /^\\d/.test(name)) return false;
      if (/^data-v-/i.test(name)) return false;
      if (/^_[A-Za-z0-9]{5,}$/.test(name)) return false;
      return true;
    };
    const segmentFor = (element) => {
      if (element.id) return '#' + CSS.escape(element.id);
      const tag = element.tagName.toLowerCase();
      const classes = Array.from(element.classList)
        .filter(isStableClass)
        .map((name) => '.' + CSS.escape(name))
        .join('');
      const parent = element.parentElement;
      if (!parent) return tag + classes;
      const siblings = Array.from(parent.children).filter(
        (sibling) => sibling.tagName === element.tagName,
      );
      const nth = siblings.length > 1
        ? ':nth-of-type(' + (siblings.indexOf(element) + 1) + ')'
        : '';
      return tag + classes + nth;
    };
    const uniquePath = (element) => {
      const segments = [];
      let current = element;
      for (let depth = 0; current && depth < 6; depth += 1) {
        segments.unshift(segmentFor(current));
        const css = segments.join(' > ');
        try {
          if (document.querySelectorAll(css).length === 1) return css;
        } catch {
          return null;
        }
        if (current.id) break;
        current = current.parentElement;
      }
      return null;
    };
    const results = [];
    for (const element of Array.from(document.querySelectorAll('*'))) {
      const ownText = Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent || '')
        .join(' ')
        .replace(/\\s+/g, ' ')
        .trim();
      const tag = element.tagName.toLowerCase();
      const alt = tag === 'img' ? element.getAttribute('alt') : null;
      if (!ownText && !alt) continue;
      const css = uniquePath(element);
      if (!css) continue;
      const rect = element.getBoundingClientRect();
      results.push({
        tag,
        role: element.getAttribute('role'),
        ownText,
        alt,
        css,
        visible: rect.width > 0 && rect.height > 0,
      });
    }
    return results;
  })()`;
}

export function parseObserved(raw: unknown): ObservedElement[] {
  if (!Array.isArray(raw)) return [];
  const parsed: ObservedElement[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate.tag !== 'string'
      || candidate.tag.length === 0
      || !(candidate.role === null || typeof candidate.role === 'string')
      || typeof candidate.ownText !== 'string'
      || !(candidate.alt === null || typeof candidate.alt === 'string')
      || typeof candidate.css !== 'string'
      || candidate.css.length === 0
      || typeof candidate.visible !== 'boolean'
    ) continue;
    parsed.push({
      tag: candidate.tag,
      role: candidate.role,
      ownText: redactSecrets(candidate.ownText),
      alt: candidate.alt === null ? null : redactSecrets(candidate.alt),
      css: candidate.css,
      visible: candidate.visible,
    });
  }
  return parsed;
}
