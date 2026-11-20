import { redactSecrets } from './secret-redaction.js';

export interface ObservedElement {
  tag: string;
  role: string | null;
  ownText: string;
  alt: string | null;
  css: string;
  visible: boolean;
}

const CSS_PATH_SOURCE = `
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
    };`;

/** Returns a self-contained script that evaluates to raw observed elements. */
export function observeScript(): string {
  return `(() => {
${CSS_PATH_SOURCE}
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

/** Installs a capturing click listener that records the hit element's CSS path. */
export function hitProbeScript(): string {
  return `(() => {
    if (window.__idt_hit_installed) return;
${CSS_PATH_SOURCE}
    document.addEventListener('click', (event) => {
      if (event.target instanceof Element) {
        const hit = uniquePath(event.target);
        window.__idt_hit = hit;
        if (hit) console.debug('__IDT_HIT__' + hit);
      }
    }, true);
    window.__idt_hit_installed = true;
  })()`;
}

export interface ActionTargetAllowance {
  route: string;
  role: string;
  name: string;
}

/** Only explicitly allowlisted semantic targets can receive a click/keyboard activation. */
export function actionGuardScript(
  allowedActions: ActionTargetAllowance[] = [],
  router: { mode: 'hash' | 'history'; base?: string } = { mode: 'history', base: '/' },
): string {
  const policy = JSON.stringify({ allowedActions, router });
  return `(() => {
    if (window.__idt_action_guard_installed) return;
    const policy = ${policy};
    const risky = /买入|卖出|买|卖|下单|交易|撤单|撤销|转账|划转|充值|提现|申购|认购|融资|还款|签约|注销|支付|提交|确认|确定|取消|删除|清空|重置|保存|密码|验证码|委托|订单|购买|account|transfer|trade|submit|payment|confirm|cancel|buy|sell|order|withdraw|delete|remove|save|reset/i;
    const stop = (event, info) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      window.__idt_blocked_action = true;
      window.__idt_blocked_action_info = info || { type: 'action_guard_rejected' };
    };
    const route = () => {
      const base = policy.router.base || '/';
      const normalizedBase = base.startsWith('/') ? base : '/' + base;
      const basePath = normalizedBase.endsWith('/') ? normalizedBase : normalizedBase + '/';
      if (policy.router.mode === 'hash') {
        if (location.pathname !== basePath) return '';
        const path = location.hash.slice(1).split(/[?#]/, 1)[0];
        return path.startsWith('/') ? path : '';
      }
      if (!location.pathname.startsWith(basePath)) return '';
      return '/' + location.pathname.slice(basePath.length);
    };
    const semanticTarget = (element) => {
      const target = element.closest('button,a,[role],[tabindex],input,select,textarea') || element;
      const tag = target.tagName?.toLowerCase();
      const inputType = target.getAttribute?.('type')?.toLowerCase();
      const inferred = target.getAttribute?.('role') || ({
        a: 'link', button: 'button', select: 'combobox',
        input: inputType === 'checkbox' ? 'checkbox' : inputType === 'radio' ? 'radio' : 'textbox',
      }[tag] || 'text');
      const name = (target.getAttribute?.('aria-label') || target.getAttribute?.('placeholder')
        || target.getAttribute?.('title') || target.getAttribute?.('alt') || target.value || target.innerText || '')
        .replace(/\\s+/g, ' ').trim();
      return { target, role: inferred, name };
    };
    const isAllowed = (element) => {
      const semantic = semanticTarget(element);
      if (!semantic.name || risky.test(semantic.name)) return false;
      return policy.allowedActions.some((allowed) =>
        allowed.route === route() && allowed.role === semantic.role && allowed.name === semantic.name,
      );
    };
    const guardActivation = (event) => {
      const element = event.target instanceof Element
        ? event.target
        : event.target && event.target.parentElement instanceof Element ? event.target.parentElement : null;
      if (!element || !isAllowed(element)) {
        const semantic = element ? semanticTarget(element) : null;
        stop(event, {
          type: 'action_guard_rejected',
          role: semantic ? semantic.role : undefined,
          name: semantic ? semantic.name : undefined,
        });
      }
    };
    document.addEventListener('click', guardActivation, true);
    document.addEventListener('submit', (e) => stop(e, { type: 'action_guard_rejected', reason: 'submit' }), true);
    document.addEventListener('change', (e) => stop(e, { type: 'action_guard_rejected', reason: 'change' }), true);
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      guardActivation(event);
    }, true);
    window.__idt_action_guard_installed = true;
  })()`;
}

export function readBlockedActionScript(): string {
  return `(() => {
    const blocked = window.__idt_blocked_action === true;
    const info = window.__idt_blocked_action_info || null;
    window.__idt_blocked_action = false;
    window.__idt_blocked_action_info = null;
    if (!blocked && !info) return null;
    return Object.assign({ type: 'action_guard_rejected' }, info || {});
  })()`;
}

/** Reads and clears the last recorded hit path. */
export function readHitScript(): string {
  return `(() => {
    const hit = typeof window.__idt_hit === 'string' ? window.__idt_hit : null;
    window.__idt_hit = null;
    return hit;
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
