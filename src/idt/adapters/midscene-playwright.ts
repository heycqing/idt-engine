import type { Page } from 'playwright';
import { resolvePlaywrightRuntime } from '../core/playwright-runtime.js';

export type MidsceneActionPhase = 'before' | 'after';

export interface MidscenePage {
  url(): string;
}

export interface MidsceneActionEvent {
  phase: MidsceneActionPhase;
  action: string;
}

export interface MidsceneAgentOptions {
  generateReport: boolean;
  modelConfig?: Record<string, string | number>;
  reportFileName?: string;
  beforeInvokeAction(actionName: string, param: unknown): Promise<void>;
  afterInvokeAction(actionName: string, param: unknown): Promise<void>;
}

export interface MidsceneAgent {
  aiAct(intent: string): Promise<string | undefined>;
  destroy(): Promise<void>;
  reportFile?: string | null;
}

export type MidsceneAgentFactory = (
  page: MidscenePage,
  options: MidsceneAgentOptions,
) => MidsceneAgent | Promise<MidsceneAgent>;

export interface ExecuteMidsceneOptions {
  page: MidscenePage;
  intent: string;
  factory?: MidsceneAgentFactory;
  reportFileName?: string;
  reportDirectory?: string;
  generateReport?: boolean;
  modelConfig?: Record<string, string | number>;
  timeoutMs?: number;
  authorizeAction?(actionName: string, param: unknown): void | Promise<void>;
  onAction(event: MidsceneActionEvent): void | Promise<void>;
}

export interface ExecuteMidsceneResult {
  summary?: string;
  reportFile?: string;
}

const SUPPORTED_ACTIONS = new Set(['tap', 'click', 'input', 'fill', 'select', 'check', 'uncheck']);

/** Convert Midscene callback names to stable, IDT-owned action labels. */
export function normalizeMidsceneAction(actionName: string): string {
  const name = actionName.trim().toLowerCase().replace(/^ai[-_]?/, '');
  const aliases: Record<string, string> = {
    tap: 'click',
    click: 'click',
    input: 'input',
    fill: 'fill',
    select: 'select',
    check: 'check',
    uncheck: 'uncheck',
  };
  return SUPPORTED_ACTIONS.has(name) ? aliases[name] ?? name : name || 'unknown';
}

async function defaultFactory(
  page: MidscenePage,
  options: MidsceneAgentOptions,
): Promise<MidsceneAgent> {
  const { PlaywrightAgent } = await import('@midscene/web/playwright');
  return new PlaywrightAgent(
    page as Page,
    options,
  );
}

/** Resolve the same Playwright peer that Midscene itself resolves. */
export function resolveMidscenePlaywrightRuntime(): typeof import('playwright') {
  return resolvePlaywrightRuntime(process.cwd());
}

export async function executeMidsceneIntent(
  options: ExecuteMidsceneOptions,
): Promise<ExecuteMidsceneResult> {
  const callback = (phase: MidsceneActionPhase) => async (
    actionName: string,
    param: unknown,
  ): Promise<void> => {
    if (phase === 'before') await options.authorizeAction?.(actionName, param);
    await options.onAction({
      phase,
      action: normalizeMidsceneAction(actionName),
    });
  };

  const factory = options.factory ?? defaultFactory;
  const priorRunDir = process.env.MIDSCENE_RUN_DIR;
  const setReportDirectory = Boolean(options.generateReport && options.reportDirectory);
  if (setReportDirectory) process.env.MIDSCENE_RUN_DIR = options.reportDirectory;

  const restoreRunDir = () => {
    if (!setReportDirectory) return;
    if (priorRunDir === undefined) delete process.env.MIDSCENE_RUN_DIR;
    else process.env.MIDSCENE_RUN_DIR = priorRunDir;
  };

  let agent: MidsceneAgent;
  try {
    agent = await factory(options.page, {
      generateReport: options.generateReport ?? false,
      ...(options.modelConfig ? { modelConfig: options.modelConfig } : {}),
      ...(options.reportFileName ? { reportFileName: options.reportFileName } : {}),
      beforeInvokeAction: callback('before'),
      afterInvokeAction: callback('after'),
    });
  } catch (error) {
    restoreRunDir();
    throw error;
  }

  const timeoutMs = options.timeoutMs ?? 60000;
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Midscene execution timed out after ${timeoutMs}ms (model-timeout)`);
      Object.assign(err, { category: 'model-timeout', code: 'model-timeout' });
      reject(err);
    }, timeoutMs);
  });

  let summary: string | undefined;
  let runFailed = false;
  let runError: unknown;
  try {
    summary = await Promise.race([
      agent.aiAct(options.intent),
      timeoutPromise,
    ]);
  } catch (error) {
    runFailed = true;
    runError = error;
  } finally {
    if (timer) clearTimeout(timer);
  }

  let destroyFailed = false;
  let destroyError: unknown;
  try {
    await agent.destroy();
  } catch (error) {
    destroyFailed = true;
    destroyError = error;
  }
  restoreRunDir();

  if (runFailed && destroyFailed) {
    throw new AggregateError([runError, destroyError], 'Midscene execution and cleanup both failed');
  }
  if (runFailed) throw runError;
  if (destroyFailed) throw destroyError;

  return {
    ...(typeof summary === 'string' ? { summary } : {}),
    ...(typeof agent.reportFile === 'string' ? { reportFile: agent.reportFile } : {}),
  };
}
