import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { IdtProject } from '../config/projects.js';
import { TAG_ROLES } from '../extract/vue-sfc.js';
import type { ProjectTopology } from '../schemas/topology.schema.js';
import type { RouterUrlOptions } from './route-url-pure.js';
import { fromBrowserUrl, toBrowserUrl } from './route-url-pure.js';
import { segmentsMatch } from '../utils/path.js';
import { compileObservation } from './observation-compiler.js';
import {
  NetworkEvidenceAllowanceSchema,
  type NetworkEvidenceAllowance,
  type ObservationDocument,
  type ObservedAction,
} from './observation-schema.js';
import { diffObserved } from './dom-delta.js';
import {
  actionGuardScript,
  hitProbeScript,
  observeScript,
  parseObserved,
  readBlockedActionScript,
  readHitScript,
  type ObservedElement,
} from './dom-observe.js';
import { redactSecrets } from './secret-redaction.js';
import {
  executeMidsceneIntent,
  normalizeMidsceneAction,
  resolveMidscenePlaywrightRuntime,
  type MidsceneAgentFactory,
  type MidscenePage,
} from '../adapters/midscene-playwright.js';

const RISKY_INTENT = /买入|卖出|下单|交易|撤单|转账|划转|充值|提现|申购|认购|融资|还款|签约|注销|支付|提交|确认|密码|验证码|account|transfer|trade|submit|payment/i;
const SENSITIVE_DATA = /token|auth|account|password|secret|credential|session|ticket|fund|idcard|phone|bank|apikey|api[-_]?key/i;
const LONG_DIGIT_SEQUENCE = /\b\d{6,20}\b/;
const LOCAL_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;
const TEST_ENV_LABELS = new Set(['dev', 'development', 'test', 'testing', 'uat', 'sit', 'stg', 'staging', 'sandbox']);
const PRODUCTION_ENV_LABELS = new Set(['prod', 'production', 'live']);

export type BlockedSecurityEvent =
  | { type: 'action_guard_rejected'; message: string; targetRole?: string; targetName?: string }
  | { type: 'navigation_blocked'; message: string; url?: string }
  | { type: 'network_guard_rejected'; message: string; method?: string; url?: string };

export interface ObservePage extends MidscenePage {
  goto(url: string): Promise<unknown>;
  installProbe(): Promise<void>;
  observe(): Promise<ObservedElement[]>;
  readHit(): Promise<string | null>;
  clearHit?(): Promise<void>;
  readBlockedAction?(): Promise<boolean>;
  readBlockedSecurityEvent?(): Promise<BlockedSecurityEvent | null>;
  drainNetwork?(): Array<{ method: string; url: string; status?: number }>;
}

export interface ObserveRuntimeSession {
  page: ObservePage;
  /** Full Playwright Page consumed by Midscene; omitted only by injected test runtimes. */
  agentPage?: MidscenePage;
  close(): Promise<void>;
}

export interface ObserveActionAllowance {
  route: string;
  role: string;
  name: string;
}

export type ObserveRuntimeFactory = (options: {
  headed: boolean;
  baseUrl: string;
  router: RouterUrlOptions;
  allowedActions: ObserveActionAllowance[];
  networkAllowlist: NetworkEvidenceAllowance[];
}) => Promise<ObserveRuntimeSession>;

export interface ObserveOptions {
  projectRoot: string;
  project: string | IdtProject;
  route: string;
  intent: string;
  baseUrl: string;
  topology: ProjectTopology;
  allowedActions: ObserveActionAllowance[];
  networkAllowlist?: NetworkEvidenceAllowance[];
  router?: RouterUrlOptions;
  headed?: boolean;
  includeReport?: boolean;
  midsceneModelConfig?: Record<string, string | number>;
  timeoutMs?: number;
  outputRoot?: string;
  runtime?: ObserveRuntimeFactory;
  agentFactory?: MidsceneAgentFactory;
}

export interface ObserveResult {
  outputDir: string;
  document: ObservationDocument;
  candidate: ReturnType<typeof compileObservation>['candidate'];
  unresolved: string[];
  reportFile?: string;
}

function projectName(project: string | IdtProject): string {
  return typeof project === 'string' ? project : project.name;
}

function assertSafeTarget(baseUrl: string, intent: string, router: RouterUrlOptions): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('IDT observe requires a valid HTTP or HTTPS base URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('IDT observe only supports HTTP or HTTPS targets');
  }
  if (parsed.username || parsed.password) {
    throw new Error('IDT observe does not allow credentials embedded in the base URL');
  }
  if ([...parsed.searchParams.keys()].some((key) => SENSITIVE_DATA.test(key))) {
    throw new Error('IDT observe does not allow sensitive query keys in the base URL');
  }
  if (!isRecognizedTestHost(parsed.hostname)) {
    throw new Error('IDT observe only allows local or recognized test environments; production/unknown hosts are blocked');
  }
  if (RISKY_INTENT.test(intent) || SENSITIVE_DATA.test(intent) || LONG_DIGIT_SEQUENCE.test(intent) || /sk-[A-Za-z0-9]{8,}/i.test(intent)) {
    throw new Error('IDT observe blocked financial intent or sensitive input data');
  }
  if (Object.keys(router.query ?? {}).some((key) => SENSITIVE_DATA.test(key))) {
    throw new Error('IDT observe does not allow sensitive query keys in router configuration');
  }
}

function validateNetworkAllowlist(allowlist: NetworkEvidenceAllowance[]): void {
  for (const item of allowlist) {
    const url = new URL(item.url);
    if (
      url.username || url.password || !isRecognizedTestHost(url.hostname)
      || [...url.searchParams.keys()].some((key) => SENSITIVE_DATA.test(key))
      || LONG_DIGIT_SEQUENCE.test(url.href)
    ) {
      throw new Error('Network allowlist may contain only exact, non-sensitive test GET URLs');
    }
  }
}

function isRecognizedTestHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (LOCAL_HOST.test(host)) return true;
  const labels = host.replace(/^\[|\]$/g, '').split(/[.-]/);
  return labels.some((label) => TEST_ENV_LABELS.has(label))
    && !labels.some((label) => PRODUCTION_ENV_LABELS.has(label));
}

export function shouldBlockObservedRequest(input: {
  url: string;
  baseOrigin: string;
  method: string;
  resourceType: string;
  isNavigation: boolean;
  networkAllowlist?: NetworkEvidenceAllowance[];
}): boolean {
  let target: URL;
  try { target = new URL(input.url); } catch { return true; }
  if (!['GET', 'HEAD'].includes(input.method.toUpperCase())) return true;
  if (input.isNavigation && target.origin !== input.baseOrigin) return true;
  const dataRequest = ['xhr', 'fetch', 'websocket'].includes(input.resourceType);
  return dataRequest && (
    !isRecognizedTestHost(target.hostname)
    || !input.networkAllowlist?.some((allowance) =>
      allowance.method === input.method.toUpperCase() && allowance.url === input.url,
    )
  );
}

function safeText(value: string): string {
  return redactSecrets(value).replace(/\b\d{6,20}\b/g, '[REDACTED]');
}

function safeErrorCategory(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const record = current && typeof current === 'object' ? current as Record<string, unknown> : {};
    if (record.category === 'action_guard_rejected' || record.code === 'action_guard_rejected') return 'action_guard_rejected';
    if (record.category === 'navigation_blocked' || record.code === 'navigation_blocked') return 'navigation_blocked';
    if (record.category === 'network_guard_rejected' || record.code === 'network_guard_rejected') return 'network_guard_rejected';
    if (record.category === 'model-timeout' || record.code === 'model-timeout') return 'model-timeout';
    const message = current instanceof Error ? current.message.toLowerCase() : typeof current === 'string' ? current.toLowerCase() : '';
    if (message.includes('action_guard_rejected')) return 'action_guard_rejected';
    if (message.includes('navigation_blocked')) return 'navigation_blocked';
    if (message.includes('network_guard_rejected')) return 'network_guard_rejected';
    const response = record.response && typeof record.response === 'object'
      ? record.response as Record<string, unknown>
      : {};
    const status = record.status ?? record.statusCode ?? response.status;
    if (typeof status === 'number' && status >= 100 && status <= 599) return `http-${status}`;
    if (/model.family|model family|midscene_model_family|not a multimodal/.test(message)) return 'model-family';
    if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid api key/.test(message)) return 'model-auth';
    if (/\b429\b|rate.?limit|quota/.test(message)) return 'model-rate-limit';
    if (/timeout|timed out|\betimedout\b/.test(message)) return 'model-timeout';
    if (/econn|enotfound|fetch failed|network|socket hang up/.test(message)) return 'model-network';
    if (/image|vision|multimodal|unsupported/.test(message)) return 'model-capability';
    if (/\b400\b|bad request|invalid_request/.test(message)) return 'model-request';
    if (/\b404\b|model not found|unknown model/.test(message)) return 'model-not-found';
    if (/\b5\d\d\b|internal server error|upstream error/.test(message)) return 'model-provider';
    if (typeof record.code === 'string' && /^[A-Z][A-Z0-9_]{1,32}$/.test(record.code)) {
      return `error-code-${record.code.toLowerCase()}`;
    }
    if (current instanceof Error && current.name !== 'Error') return safeText(current.name).slice(0, 80);
    current = record.cause;
  }
  return 'unclassified';
}

function safeErrorSummary(error: unknown, modelConfig: Record<string, string | number> | undefined): string {
  if (!(error instanceof Error)) return `Observation failed (${typeof error})`;
  const category = safeErrorCategory(error);
  let message = error.message;
  for (const [key, value] of Object.entries(modelConfig ?? {})) {
    if (/API_KEY|TOKEN|SECRET|PASSWORD/i.test(key) && typeof value === 'string' && value.length > 0) {
      message = message.split(value).join('[REDACTED]');
    }
  }
  message = message
    .replace(/https?:\/\/[^\s)"']+/gi, (raw) => {
      try {
        const url = new URL(raw);
        return `${url.protocol}//${url.host}${url.pathname}`;
      } catch { return '[URL]'; }
    })
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_\-]{24,}\b/g, '[REDACTED]')
    .replace(/\b\d{6,20}\b/g, '[REDACTED]')
    .replace(/(api[-_]?key|token|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();
  if (category !== 'unclassified') return `${category}: ${safeText(message).slice(0, 240)}`;
  const stackModules = (error.stack ?? '').split('\n').slice(1, 8).map((frame) => {
    const normalized = frame.replace(/\\/g, '/');
    const functionName = normalized.match(/^\s*at\s+([^\s(]+)/)?.[1]?.split('.').at(-1);
    const packageIndex = normalized.lastIndexOf('/node_modules/');
    if (packageIndex >= 0) {
      const suffix = normalized.slice(packageIndex + '/node_modules/'.length);
      const packageName = suffix.match(/^(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/)?.[1];
      const file = suffix.match(/((?:\.pnpm\/[^/]+\/node_modules\/)?(?:@[^/]+\/)?[^/]+\/[^():]+\.(?:js|mjs|cjs)):\d+:\d+/)?.[1];
      return `${file ?? packageName ?? 'node-module'}${functionName ? `#${functionName}` : ''}`;
    }
    return '';
  }).filter(Boolean);
  const frameSummary = stackModules.length ? ` (${stackModules.join(' → ')})` : '';
  return `${category}: ${safeText(message).slice(0, 240)}${frameSummary}`;
}

function safeUrl(rawUrl: string, router: RouterUrlOptions, topology: ProjectTopology): { url: string; unresolved: string[] } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { url: '', unresolved: ['Observed URL is invalid'] };
  }
  const unresolved: string[] = [];
  if (parsed.username || parsed.password) {
    parsed.username = '';
    parsed.password = '';
    unresolved.push('Observed URL contained credentials; removed before persistence');
  }

  const observedRoute = fromBrowserUrl(parsed.href, router);
  const matchedPattern = observedRoute
    ? Object.keys(topology.routes).find((pattern) => segmentsMatch(pattern, observedRoute))
    : undefined;
  const isCaseVariant = Boolean(
    observedRoute && matchedPattern && matchedPattern.toLowerCase() === observedRoute.toLowerCase(),
  );
  const route = observedRoute && Object.hasOwn(topology.routes, observedRoute)
    ? observedRoute
    : isCaseVariant
      ? observedRoute
      : matchedPattern;
  if (!route) unresolved.push('Observed route is unknown; its path was redacted');
  else if (route !== observedRoute) unresolved.push('Concrete dynamic route path was replaced with its route pattern');

  const allowed = router.query ?? {};
  const queryMatches = (rawQuery: string) => {
    if (!rawQuery) return true;
    const actual = new URLSearchParams(rawQuery);
    return [...actual.entries()].every(([key, value]) => allowed[key] === value);
  };
  let observedRouterQuery = parsed.search;
  if (router.mode === 'hash') {
    const rawHash = parsed.hash.slice(1).split('#', 1)[0];
    const queryIndex = rawHash.indexOf('?');
    observedRouterQuery = queryIndex >= 0 ? rawHash.slice(queryIndex + 1) : '';
    if (parsed.search) unresolved.push('Outer query data is not part of the configured hash route context');
  }
  if (!queryMatches(observedRouterQuery)) {
    unresolved.push('Observed query context differs from the configured route context; unsafe values were removed');
  }
  const redactQuery = (query: string) => {
    if (!query) return;
    const params = new URLSearchParams(query);
    let changed = false;
    for (const [key, value] of [...params.entries()]) {
      if (allowed[key] !== value) {
        params.delete(key);
        changed = true;
      }
    }
    if (changed) unresolved.push('Unconfigured URL query data was removed');
  };
  redactQuery(parsed.search);
  if (router.mode === 'hash' && parsed.hash.includes('?')) {
    const rawHash = parsed.hash.slice(1);
    const rawFragment = rawHash.split('#', 1)[0];
    const queryIndex = rawFragment.indexOf('?');
    if (queryIndex >= 0) redactQuery(rawFragment.slice(queryIndex + 1));
    if (rawHash.includes('#')) unresolved.push('Unconfigured nested hash fragment was removed');
  } else if (router.mode !== 'hash' && parsed.hash) {
    unresolved.push('Unconfigured URL fragment was removed');
  }

  const safeRoute = route ?? '/__unknown__';
  const reconstructedRouter = observedRouterQuery ? router : { ...router, query: {} };
  return { url: new URL(toBrowserUrl(safeRoute, reconstructedRouter), parsed.origin).href, unresolved };
}

function semanticName(element: ObservedElement): { role?: string; name?: string } {
  const role = element.role || TAG_ROLES[element.tag] || (element.ownText ? 'text' : undefined);
  const name = safeText(element.ownText || element.alt || '');
  return {
    ...(role ? { role } : {}),
    ...(name ? { name } : {}),
  };
}

function targetElement(elements: ObservedElement[], selector: string | null): ObservedElement | undefined {
  if (!selector) return undefined;
  return elements
    .filter(({ css }) => css === selector || selector.startsWith(`${css} > `))
    .sort((a, b) => b.css.length - a.css.length)[0];
}

function appearedElements(before: ObservedElement[], after: ObservedElement[]) {
  return diffObserved(before, after).map((element) => {
    const semantic = semanticName(element);
    return {
      ...(semantic.role ? { role: semantic.role } : {}),
      ...(semantic.name ? { name: semantic.name, text: semantic.name } : {}),
    };
  });
}

function atomicWrite(filePath: string, text: string): void {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, text, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]!);
}

function renderObservationReport(document: ObservationDocument, unresolved: string[]): string {
  const rows = document.actions.map((action) => `<tr>
    <td>${action.sequence}</td><td>${escapeHtml(action.sourceType)}</td>
    <td>${escapeHtml([action.targetRole, action.targetName].filter(Boolean).join(' / ') || '未识别')}</td>
    <td>${escapeHtml(action.beforeUrl)}<br>→ ${escapeHtml(action.afterUrl)}</td>
    <td>${escapeHtml(action.appearedElements.map((element) => [element.role, element.name].filter(Boolean).join(' / ')).filter(Boolean).join('；') || '无')}</td>
  </tr>`).join('\n');
  const issues = unresolved.length
    ? `<ul>${unresolved.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
    : '<p>无未解决项。候选仍需人工审阅和显式晋升。</p>';
  return `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><title>IDT Observation</title>
<style>body{font:14px/1.6 system-ui,sans-serif;max-width:1100px;margin:32px auto;padding:0 20px;color:#202124}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d8dce2;padding:8px;text-align:left;vertical-align:top}th{background:#f3f5f8}code{overflow-wrap:anywhere}.note{color:#5f6368}</style>
<h1>IDT Observation Report</h1>
<dl><dt>项目 / 路由</dt><dd>${escapeHtml(document.project)} · ${escapeHtml(document.route)}</dd>
<dt>意图</dt><dd>${escapeHtml(document.intent)}</dd><dt>观测时间</dt><dd>${escapeHtml(document.createdAt)}</dd>
<dt>Provider 状态</dt><dd>${escapeHtml(document.provider_status || '未记录')}</dd></dl>
<h2>动作与证据</h2><table><thead><tr><th>#</th><th>动作</th><th>目标</th><th>URL 前后</th><th>新出现的语义元素</th></tr></thead><tbody>${rows || '<tr><td colspan="5">没有完成的动作回调</td></tr>'}</tbody></table>
<h2>未解决项</h2>${issues}<p class="note">通过状态和报告文字由 IDT 生成；Midscene 的自然语言总结不作为 verdict。报告不包含 Midscene 原始参数、请求/响应体或 headers。</p>
</html>\n`;
}

function persistObservation(
  outputDir: string,
  document: ObservationDocument,
  topology: ProjectTopology,
  networkAllowlist: NetworkEvidenceAllowance[] = [],
): ReturnType<typeof compileObservation> {
  const compiled = compileObservation({ document, topology, networkAllowlist });
  atomicWrite(path.join(outputDir, 'observation.json'), JSON.stringify(document, null, 2) + '\n');
  atomicWrite(path.join(outputDir, 'candidate.ir.json'), JSON.stringify(compiled.candidate, null, 2) + '\n');
  atomicWrite(path.join(outputDir, 'report.html'), renderObservationReport(document, compiled.unresolved));
  return compiled;
}

async function defaultRuntime(options: {
  headed: boolean;
  baseUrl: string;
  router: RouterUrlOptions;
  allowedActions: ObserveActionAllowance[];
  networkAllowlist: NetworkEvidenceAllowance[];
}): Promise<ObserveRuntimeSession> {
  const { chromium } = resolveMidscenePlaywrightRuntime();
  const browser: Browser = await chromium.launch({ headless: !options.headed });
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext({ serviceWorkers: 'block' });
    const page: Page = await context.newPage();
    const baseOrigin = new URL(options.baseUrl).origin;
    let lastBlockedEvent: BlockedSecurityEvent | null = null;
    let observedNetwork: Array<{ method: string; url: string; status: number }> = [];
    const approvedNetwork = new Set(options.networkAllowlist.map((entry) => `${entry.method}\u0000${entry.url}`));
    page.on('response', (response) => {
      const method = response.request().method().toUpperCase();
      const url = response.url();
      if (approvedNetwork.has(`${method}\u0000${url}`)) {
        observedNetwork.push({ method, url, status: response.status() });
      }
    });
    await context.route('**/*', async (route) => {
      const request = route.request();
      const isNav = request.isNavigationRequest() || ['document', 'subframe'].includes(request.resourceType());
      const safetyBlock = shouldBlockObservedRequest({
        url: request.url(),
        baseOrigin,
        method: request.method(),
        resourceType: request.resourceType(),
        isNavigation: request.isNavigationRequest(),
        networkAllowlist: options.networkAllowlist,
      });
      if (safetyBlock) {
        if (isNav) {
          lastBlockedEvent = {
            type: 'navigation_blocked',
            message: `IDT observe blocked an external or cross-origin navigation to ${safeText(request.url())} (navigation_blocked)`,
            url: request.url(),
          };
        } else {
          lastBlockedEvent = {
            type: 'network_guard_rejected',
            message: `IDT observe blocked an unapproved network request ${request.method()} ${safeText(request.url())} (network_guard_rejected)`,
            method: request.method(),
            url: request.url(),
          };
        }
        await route.abort('blockedbyclient');
        return;
      }
      const dataRequest = ['xhr', 'fetch'].includes(request.resourceType());
      if (request.isNavigationRequest() || dataRequest) {
        try {
          const response = await route.fetch({ maxRedirects: 0 });
          if (response.status() >= 300 && response.status() < 400) {
            lastBlockedEvent = {
              type: 'navigation_blocked',
              message: `IDT observe blocked a redirect (${response.status()}) to ${safeText(request.url())} (navigation_blocked)`,
              url: request.url(),
            };
            await route.abort('blockedbyclient');
            return;
          }
          await route.fulfill({ response });
        } catch {
          lastBlockedEvent = isNav
            ? {
                type: 'navigation_blocked',
                message: `IDT observe navigation aborted or failed for ${safeText(request.url())} (navigation_blocked)`,
                url: request.url(),
              }
            : {
                type: 'network_guard_rejected',
                message: `IDT observe network request aborted or failed for ${request.method()} ${safeText(request.url())} (network_guard_rejected)`,
                method: request.method(),
                url: request.url(),
              };
          await route.abort('blockedbyclient').catch(() => {});
        }
        return;
      }
      await route.continue();
    });
    await context.routeWebSocket('**/*', (socket) => socket.close());
    let lastHit: string | null = null;
    page.on('console', (message) => {
      const value = message.text();
      if (value.startsWith('__IDT_HIT__')) lastHit = value.slice('__IDT_HIT__'.length);
    });
    await page.addInitScript(actionGuardScript(options.allowedActions, options.router));
    await page.addInitScript(hitProbeScript());
    return {
      page: {
        url: () => page.url(),
        goto: (url) => page.goto(url),
        async installProbe() {
          await page.evaluate(actionGuardScript(options.allowedActions, options.router));
          await page.evaluate(hitProbeScript());
        },
        async observe() { return parseObserved(await page.evaluate(observeScript())); },
        async readHit() {
          const pageHit = await page.evaluate(readHitScript());
          const hit = lastHit ?? (typeof pageHit === 'string' ? pageHit : null);
          lastHit = null;
          return hit;
        },
        async clearHit() {
          lastHit = null;
          lastBlockedEvent = null;
          await page.evaluate(readHitScript());
          await page.evaluate(readBlockedActionScript());
        },
        async readBlockedSecurityEvent() {
          const pageInfo: any = await page.evaluate(readBlockedActionScript());
          if (pageInfo) {
            const label = pageInfo.name ? ` "${pageInfo.name}"` : '';
            const role = pageInfo.role ? ` (${pageInfo.role})` : '';
            return {
              type: 'action_guard_rejected',
              message: `IDT observe blocked an unapproved or risky control${label}${role} (action_guard_rejected)`,
              targetRole: pageInfo.role,
              targetName: pageInfo.name,
            };
          }
          if (lastBlockedEvent) {
            const event = lastBlockedEvent;
            lastBlockedEvent = null;
            return event;
          }
          return null;
        },
        async readBlockedAction() {
          const event = await this.readBlockedSecurityEvent();
          return Boolean(event);
        },
        drainNetwork() {
          const snapshot = observedNetwork;
          observedNetwork = [];
          return snapshot;
        },
      },
      agentPage: page,
      async close() {
        let closeError: unknown;
        try { await context?.close(); } catch (error) { closeError = error; }
        try { await browser.close(); } catch (error) {
          if (closeError !== undefined) throw new AggregateError([closeError, error], 'Browser cleanup failed');
          throw error;
        }
        if (closeError !== undefined) throw closeError;
      },
    };
  } catch (error) {
    try { await context?.close(); } catch { /* always attempt browser shutdown */ }
    try { await browser.close(); } catch { /* preserve the initialization error */ }
    throw error;
  }
}

export async function observe(options: ObserveOptions): Promise<ObserveResult> {
  const name = projectName(options.project);
  const router = options.router ?? options.topology.router ?? { mode: 'history' as const, base: '/' };
  assertSafeTarget(options.baseUrl, options.intent, router);
  if (options.topology.project && options.topology.project !== name) {
    throw new Error(`Observation project ${name} does not match topology ${options.topology.project}`);
  }
  if (!Object.hasOwn(options.topology.routes, options.route)) {
    throw new Error(`Unknown observation route ${options.route}`);
  }
  if (!options.allowedActions.length) {
    throw new Error('IDT observe requires an explicit route/role/name click allowlist');
  }
  for (const allowed of options.allowedActions) {
    if (!Object.hasOwn(options.topology.routes, allowed.route)) {
      throw new Error('Click allowlist contains an unknown route');
    }
    const matching = options.topology.routes[allowed.route].elements.filter((element) =>
      element.role === allowed.role && element.name === allowed.name,
    );
    if (
      matching.length !== 1
      || matching[0].dynamic
      || matching[0].deferred
      || matching[0].dataScoped
      || RISKY_INTENT.test(allowed.name)
    ) {
      throw new Error('Click allowlist target must be a unique static, safe semantic element');
    }
  }
  const networkAllowlist = NetworkEvidenceAllowanceSchema.array().parse(options.networkAllowlist ?? []);
  validateNetworkAllowlist(networkAllowlist);
  if (
    !options.agentFactory
    && (!options.midsceneModelConfig?.MIDSCENE_MODEL_API_KEY
      || !options.midsceneModelConfig.MIDSCENE_MODEL_BASE_URL
      || !options.midsceneModelConfig.MIDSCENE_MODEL_NAME
      || !options.midsceneModelConfig.MIDSCENE_MODEL_FAMILY)
  ) {
    throw new Error('Midscene requires MIDSCENE_MODEL_NAME and MIDSCENE_MODEL_FAMILY plus a model API key/base URL; configure them in .env.idt.local or the process environment');
  }

  const observationsRoot = path.resolve(options.projectRoot, '.idt', 'observations');
  const outputRoot = path.resolve(options.outputRoot ?? observationsRoot);
  const relativeOutput = path.relative(observationsRoot, outputRoot);
  if (relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) {
    throw new Error('Observation output must remain inside <project>/.idt/observations');
  }
  fs.mkdirSync(observationsRoot, { recursive: true });
  fs.mkdirSync(outputRoot, { recursive: true });
  const realProjectRoot = fs.realpathSync(options.projectRoot);
  const realObservationsRoot = fs.realpathSync(observationsRoot);
  const realOutputRoot = fs.realpathSync(outputRoot);
  const within = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };
  if (!within(realProjectRoot, realObservationsRoot) || !within(realObservationsRoot, realOutputRoot)) {
    throw new Error('Observation output resolves outside the ignored project observation directory');
  }
  if (name !== path.basename(name) || name === '.' || name === '..' || /[\\/]/.test(name)) {
    throw new Error('Project name is not a safe observation directory name');
  }
  const projectOutputRoot = path.join(realOutputRoot, name);
  fs.mkdirSync(projectOutputRoot, { recursive: true });
  const realProjectOutputRoot = fs.realpathSync(projectOutputRoot);
  if (!within(realObservationsRoot, realProjectOutputRoot)) {
    throw new Error('Project observation directory resolves outside <project>/.idt/observations');
  }
  const outputDir = path.join(realProjectOutputRoot, `${Date.now()}-${randomUUID()}`);
  fs.mkdirSync(outputDir, { recursive: true });

  const document: ObservationDocument = {
    schemaVersion: 1,
    project: name,
    route: options.route,
    intent: safeText(options.intent),
    createdAt: new Date().toISOString(),
    actions: [],
    unresolved: [],
  };
  let pending: {
    action: string;
    beforeUrl: string;
    beforeObserved: ObservedElement[];
  } | undefined;

  let session: ObserveRuntimeSession | undefined;
  let operationFailed = false;
  try {
    session = await (options.runtime ?? defaultRuntime)({
      headed: options.headed ?? false,
      baseUrl: options.baseUrl,
      router,
      allowedActions: options.allowedActions,
      networkAllowlist,
    });
    const currentSession = session;
    const startUrl = new URL(toBrowserUrl(options.route, router), options.baseUrl).href;
    await currentSession.page.goto(startUrl);
    await currentSession.page.installProbe();
    currentSession.page.drainNetwork?.();

    const captureUrl = (url: string) => {
        const result = safeUrl(url, router, options.topology);
      document.unresolved.push(...result.unresolved);
      return result.url;
    };

    const execution = await executeMidsceneIntent({
      page: currentSession.agentPage ?? currentSession.page,
      intent: options.intent,
      factory: options.agentFactory,
      modelConfig: options.midsceneModelConfig,
      generateReport: options.includeReport ?? false,
      reportFileName: options.includeReport ? 'midscene-report.html' : undefined,
      reportDirectory: options.includeReport ? path.join(outputDir, 'midscene_run') : undefined,
      timeoutMs: options.timeoutMs,
      authorizeAction: (_actionName, param) => {
        const action = normalizeMidsceneAction(_actionName);
        if (action !== 'click') {
          const err = new Error('IDT observe currently permits only read-only click exploration (action_guard_rejected)');
          Object.assign(err, { category: 'action_guard_rejected', code: 'action_guard_rejected' });
          throw err;
        }
        let serialized: string;
        try {
          serialized = typeof param === 'string' ? param : JSON.stringify(param ?? '');
        } catch {
          const err = new Error('IDT observe blocked an action with uninspectable parameters (action_guard_rejected)');
          Object.assign(err, { category: 'action_guard_rejected', code: 'action_guard_rejected' });
          throw err;
        }
        if (RISKY_INTENT.test(serialized)) {
          const err = new Error('IDT observe blocked a financial or state-changing page action (action_guard_rejected)');
          Object.assign(err, { category: 'action_guard_rejected', code: 'action_guard_rejected' });
          throw err;
        }
      },
      onAction: async (event) => {
        if (event.phase === 'before') {
          if (pending) document.unresolved.push('Nested Midscene action callbacks are unsupported');
          await currentSession.page.clearHit?.();
          currentSession.page.drainNetwork?.();
          const observed = await currentSession.page.observe();
          pending = {
            action: event.action,
            beforeUrl: captureUrl(currentSession.page.url()),
            beforeObserved: observed,
          };
          return;
        }

        if (!pending) {
          document.unresolved.push('Midscene action finished without a matching before callback');
          return;
        }
        const blockedSecurity = await currentSession.page.readBlockedSecurityEvent?.();
        if (blockedSecurity) {
          pending = undefined;
          const err = new Error(blockedSecurity.message);
          Object.assign(err, { category: blockedSecurity.type, code: blockedSecurity.type });
          throw err;
        }
        if (await currentSession.page.readBlockedAction?.()) {
          pending = undefined;
          const err = new Error('IDT observe blocked an unapproved or risky control (action_guard_rejected)');
          Object.assign(err, { category: 'action_guard_rejected', code: 'action_guard_rejected' });
          throw err;
        }
        if (pending.action !== event.action) {
          document.unresolved.push('Midscene before/after action types do not match');
        }
        const afterObserved = await currentSession.page.observe();
        const hit = await currentSession.page.readHit();
        const network = currentSession.page.drainNetwork?.() ?? [];
        const target = targetElement(pending.beforeObserved, hit);
        const targetSemantic = target ? semanticName(target) : {};
        const afterUrl = captureUrl(currentSession.page.url());
        const action: ObservedAction = {
          sequence: document.actions.length,
          sourceType: pending.action,
          description: pending.action,
          beforeUrl: pending.beforeUrl,
          afterUrl,
          ...(targetSemantic.role ? { targetRole: targetSemantic.role } : {}),
          ...(targetSemantic.name ? { targetName: targetSemantic.name } : {}),
          appearedElements: appearedElements(pending.beforeObserved, afterObserved),
          network,
          unresolved: [],
        };
        if (!hit || !targetSemantic.role || !targetSemantic.name) {
          action.unresolved.push('IDT could not observe a unique semantic action target');
        }
        if (pending.action === 'input' || pending.action === 'fill' || pending.action === 'select') {
          action.unresolved.push('Sensitive-safe replay input was not captured; add an explicit placeholder before promotion');
        }
        document.actions.push(action);
        pending = undefined;
      },
    });
    if (pending) document.unresolved.push('Midscene execution ended with an incomplete action callback');
    document.provider_status = 'success';
    const compiled = persistObservation(outputDir, document, options.topology, networkAllowlist);
    return {
      outputDir,
      document,
      candidate: compiled.candidate,
      unresolved: compiled.unresolved,
      ...(execution.reportFile ? { reportFile: execution.reportFile } : {}),
    };
  } catch (error) {
    operationFailed = true;
    const errorType = safeErrorCategory(error);
    document.provider_status = errorType === 'model-timeout' ? 'timeout' : 'error';
    document.unresolved.push(`Observation failed (${safeText(errorType)}); ${safeErrorSummary(error, options.midsceneModelConfig)}`);
    try { persistObservation(outputDir, document, options.topology, networkAllowlist); } catch { /* retain partial diagnostics when valid */ }
    const failure = new Error(`IDT observe failed; redacted diagnostics saved to ${outputDir}`);
    Object.assign(failure, { exitCode: 1 });
    throw failure;
  } finally {
    if (session) {
      if (operationFailed) {
        try { await session.close(); } catch { /* preserve the original observation failure */ }
      } else {
        try { await session.close(); } catch {
          throw new Error(`Browser cleanup failed; observation artifacts remain under ${outputDir}`);
        }
      }
    }
  }
}
