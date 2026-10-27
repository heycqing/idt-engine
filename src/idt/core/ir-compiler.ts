import fs from 'node:fs';
import path from 'node:path';
import {
  extractProjectTopology,
  readSemanticIndex,
  type ExtractTopologyOptions,
} from '../extract/topology.js';
import { findRoutePath } from './pathfinder.js';
import { flowIdFromIntent } from './intent.js';
import {
  StateTransitionIRSchema,
  type StateTransitionIR,
} from './ir-schema.js';
import { validateIr, ValidationError } from './validate-ir.js';
import { findEvidenceGaps } from './action-evidence.js';
import type { ModelClient } from './openai-client.js';
import { redactSecrets } from './secret-redaction.js';

export { type ModelClient } from './openai-client.js';
export { redactSecrets } from './secret-redaction.js';

export const IR_SYSTEM_PROMPT = `You are a frontend testing and state transition compiler.
Your task is to generate a StateTransitionIR JSON object matching the StateTransitionIRSchema.

Shape:
{
  "description": string,
  "initialRoute": string,            // must be the first entry of routeFlow
  "setup": { "notes": string[] },
  "unresolved": string[],
  "stages": [                        // at least one
    {
      "stageIndex": number,          // 0-based, matches array position
      "stageName": string,
      "routePattern": string,        // must come from routeFlow
      "actions": [
        {
          "actionType": "CLICK" | "FILL" | "SELECT" | "CHECK",
          "targetRole": "button" | "link" | "textbox" | "checkbox" | "radio" | "combobox" | "heading" | "tab" | "text",
          "targetName": string,
          "inputValue": string,      // FILL and SELECT only
          "triggersRequest": boolean
        }
      ],
      "invariants": {
        "network": [ { "method": "GET"|"POST"|"PUT"|"DELETE"|"PATCH", "urlPattern": string, "expectedStatus": number } ],
        "routeGuard": { "targetUrlPattern": string, "readyRole": string, "readyName": string }
      }
    }
  ]
}

Requirements:
1. Output ONLY a valid JSON object. No markdown fences, no explanations.
2. DO NOT output flowId, intent or oracle. The engine fills those in; anything you write there is discarded.
3. Every targetRole and targetName pair must come from the "elements" list of the matching page in the payload, or from the provided code slices or prose case. The elements list is a static candidate set, not a guarantee; never invent a name that is not in it.
4. An element with "dynamic": true has a name that is only known at runtime. Do not guess it.
4a. "text" is not an ARIA role. It marks a clickable element that has no role but does carry static text (a <div> or <span> with a click handler). It is located by its exact text. Use it only when the payload's elements list says so; never substitute it for a real role, and never use it for routeGuard readyRole.
5. Network invariant method, urlPattern, expectedStatus, and assertResponseFields must strictly come from code slices or prose case assertions.
6. An intent that only opens a page is one stage with an empty "actions" array, asserted through invariants.routeGuard. This is valid output. An empty elements list or absent code slices is NOT a reason to return zero stages.
6a. routeGuard.readyRole and readyName are under the SAME rule as targetRole and targetName: the pair must appear verbatim in that page's "elements" list, and an element with "dynamic": true has no usable name. If no element of the page qualifies, omit readyRole and readyName entirely and let the routeGuard assert the URL alone. Never fall back to the page title, a semanticKeyword, or any other string outside the elements list.
7. "unresolved" is only for operations the intent asks for but the payload cannot support: a required control missing from the elements list, a value with no matching input, or a name that is dynamic. Never put complaints about the payload itself (such as missing code slices) in it. A non-empty "unresolved" blocks spec emission, so leave it empty when the flow is fully determined.
`;

export interface CompileIntentOptions {
  projectRoot: string;
  intent: string;
  proseCase?: string;
  model: ModelClient;
  force?: boolean;
  /** 多项目模式下项目根没有 idt.config.ts，globs 必须由调用方给。 */
  extract?: ExtractTopologyOptions;
  /**
   * 直接钉住路由，跳过关键词匹配与寻径。批量生成时用——按路由遍历比靠
   * 意图措辞去猜可靠得多，也绕开了关键词碰撞。
   */
  route?: string;
}

export async function compileIntent(
  options: CompileIntentOptions
): Promise<StateTransitionIR> {
  const { projectRoot, intent, proseCase, model, force, extract, route } = options;

  // 1. Extract project topology and read semantic index
  const topology = extractProjectTopology(projectRoot, extract);
  const semanticIndex = readSemanticIndex(projectRoot);

  // 2. Find route path（钉了路由就不走匹配）
  let routePath: string[];
  if (route) {
    if (!topology.routes[route]) {
      const error = new Error(`拓扑里没有路由 "${route}"。先跑 idt:sync，或检查路由写法。`);
      (error as any).exitCode = 2;
      throw error;
    }
    routePath = [route];
  } else {
    routePath = findRoutePath(topology, semanticIndex, intent).routePath;
  }

  // Check target file conflicts early
  const flowId = flowIdFromIntent(intent);
  const genDir = path.resolve(projectRoot, 'tests/e2e/generated');
  const targetIrFile = path.join(genDir, `${flowId}.ir.json`);
  const targetSpecFile = path.join(genDir, `${flowId}.spec.ts`);

  if (!force && (fs.existsSync(targetIrFile) || fs.existsSync(targetSpecFile))) {
    const error = new Error(
      `Target file ${targetIrFile} or ${targetSpecFile} already exists. Pass force: true to overwrite.`
    );
    (error as any).exitCode = 2;
    throw error;
  }

  // 3 & 4. Build user message and redact slices
  let processedProse: string | null = null;
  let proseCaseTruncated = false;
  if (typeof proseCase === 'string') {
    if (proseCase.length > 4000) {
      processedProse = redactSecrets(proseCase.slice(0, 4000));
      proseCaseTruncated = true;
    } else {
      processedProse = redactSecrets(proseCase);
      proseCaseTruncated = false;
    }
  }

  const slices: Array<{ route: string; code: string }> = [];
  for (const route of routePath) {
    const node = topology.routes[route];
    if (node?.transitions) {
      for (const transition of node.transitions) {
        if (transition.codeSlice) {
          slices.push({ route, code: redactSecrets(transition.codeSlice) });
        }
      }
    }
  }

  // 按 routeFlow 顺序给出页面，不把整张拓扑塞进上下文。
  const pages = routePath.map((route) => {
    const node = topology.routes[route];
    return {
      route,
      title: node?.title ?? '',
      semanticKeywords: node?.semanticKeywords ?? [],
      elements: (node?.elements ?? []).map((element) => ({
        ...element,
        ...(element.name ? { name: redactSecrets(element.name) } : {}),
      })),
    };
  });

  const userPayload = {
    intent,
    proseCase: processedProse,
    proseCaseTruncated,
    routeFlow: routePath,
    pages,
    slices,
  };
  const userContent = JSON.stringify(userPayload);

  // 5. Call model with retry
  const messages: Array<{ role: 'user'; content: string }> = [
    { role: 'user', content: userContent },
  ];

  let rawResponse = await model.complete({
    system: IR_SYSTEM_PROMPT,
    messages,
    temperature: 0,
    responseFormat: 'json_object',
  });

  function parseAndValidate(raw: string): {
    ir: StateTransitionIR | null;
    error: string | null;
  } {
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (err: any) {
      return { ir: null, error: `JSON parse error: ${err.message}` };
    }

    // flowId、intent 和 oracle 由引擎决定，模型写什么都会被覆盖。校验必须在
    // 覆盖之后进行：flowId 是 intent 的哈希，模型猜不中，先校验等于每次必败。
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      parsed.flowId = flowId;
      parsed.intent = intent;
      parsed.oracle = proseCase ? 'prose-case' : 'regression-lock';
    }

    const zodRes = StateTransitionIRSchema.safeParse(parsed);
    if (!zodRes.success) {
      return {
        ir: null,
        error: `IR schema validation error: ${zodRes.error.message}`,
      };
    }
    return { ir: zodRes.data, error: null };
  }

  let result = parseAndValidate(rawResponse);
  if (result.error) {
    // Retry once with error text as next user message
    messages.push({ role: 'user', content: result.error });
    rawResponse = await model.complete({
      system: IR_SYSTEM_PROMPT,
      messages,
      temperature: 0,
      responseFormat: 'json_object',
    });
    result = parseAndValidate(rawResponse);
  }

  if (result.error || !result.ir) {
    // Write last raw response to .idt/last-compile-error.json (.tmp then rename)
    const idtDir = path.resolve(projectRoot, '.idt');
    fs.mkdirSync(idtDir, { recursive: true });
    const errorFile = path.join(idtDir, 'last-compile-error.json');
    const tmpErrorFile = path.join(idtDir, 'last-compile-error.json.tmp');
    const errorData = {
      rawResponse,
      error: result.error,
    };
    fs.writeFileSync(tmpErrorFile, JSON.stringify(errorData, null, 2), 'utf8');
    fs.renameSync(tmpErrorFile, errorFile);

    const compileError = new Error(
      `IR compilation failed after 2 attempts: ${result.error}`
    );
    (compileError as any).exitCode = 1;
    throw compileError;
  }

  // 6. validateIr（flowId / intent / oracle 已在 parseAndValidate 里注入）
  const ir = result.ir;

  validateIr(ir, {
    projectRoot,
    routePath,
    proseCase,
    mode: 'gen',
    checkEvidence: false,
  });

  // 7. Write tests/e2e/generated/<flowId>.ir.json (.tmp then rename)
  fs.mkdirSync(genDir, { recursive: true });
  const tmpIrFile = path.join(genDir, `${flowId}.ir.json.tmp`);
  fs.writeFileSync(tmpIrFile, JSON.stringify(ir, null, 2), 'utf8');
  fs.renameSync(tmpIrFile, targetIrFile);

  // 8. Evidence gaps keep the IR available for probe, but block spec emission.
  const evidenceGaps = findEvidenceGaps(ir);
  if (evidenceGaps.length > 0) {
    const relativeIrPath = path.relative(projectRoot, targetIrFile).replace(/\\/g, '/');
    const stages = evidenceGaps
      .map((gap) => `stage ${gap.stageIndex}「${gap.stageName}」`)
      .join('、');
    throw new ValidationError(
      `已写出 IR：${relativeIrPath}\n`
        + `${stages}有需要硬证据的动作，但一条证据都没有，因此没有产出 spec。\n`
        + `跑 pnpm idt:probe ${relativeIrPath} 探一次动作后的 DOM 增量；`
        + `多候选时用 --pick <序号> 选一个。`,
      2,
    );
  }

  return ir;
}
