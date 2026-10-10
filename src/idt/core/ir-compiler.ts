import fs from 'node:fs';
import path from 'node:path';
import { extractProjectTopology, readSemanticIndex } from '../extract/topology.js';
import { findRoutePath } from './pathfinder.js';
import { flowIdFromIntent } from './intent.js';
import {
  StateTransitionIRSchema,
  type StateTransitionIR,
} from './ir-schema.js';
import { validateIr } from './validate-ir.js';
import type { ModelClient } from './openai-client.js';

export { type ModelClient } from './openai-client.js';

export const IR_SYSTEM_PROMPT = `You are a frontend testing and state transition compiler.
Your task is to generate a StateTransitionIR JSON object matching the StateTransitionIRSchema.
Requirements:
1. Output ONLY a valid JSON object. No markdown fences, no explanations.
2. Element targetRole and targetName must strictly come from the provided code slices or prose case.
3. Network invariant method, urlPattern, expectedStatus, and assertResponseFields must strictly come from code slices or prose case assertions.
4. If any action, prerequisite, or step cannot be determined from the slices or prose case, put a description in the "unresolved" array. DO NOT invent or guess actions.
`;

export function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9]{8,}/g, '[REDACTED]')
    .replace(/(Bearer\s+)(?!\[REDACTED\])\S+/g, '$1[REDACTED]')
    .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED]');
}

export interface CompileIntentOptions {
  projectRoot: string;
  intent: string;
  proseCase?: string;
  model: ModelClient;
  force?: boolean;
}

export async function compileIntent(
  options: CompileIntentOptions
): Promise<StateTransitionIR> {
  const { projectRoot, intent, proseCase, model, force } = options;

  // 1. Extract project topology and read semantic index
  const topology = extractProjectTopology(projectRoot);
  const semanticIndex = readSemanticIndex(projectRoot);

  // 2. Find route path
  const { routePath } = findRoutePath(topology, semanticIndex, intent);

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

  const userPayload = {
    intent,
    proseCase: processedProse,
    proseCaseTruncated,
    routeFlow: routePath,
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

  // 6. Overwrite flowId and oracle, then validateIr
  const ir = result.ir;
  ir.flowId = flowId;
  ir.intent = intent;
  ir.oracle = proseCase ? 'prose-case' : 'regression-lock';

  validateIr(ir, {
    projectRoot,
    routePath,
    proseCase,
    mode: 'gen',
  });

  // 7. Write tests/e2e/generated/<flowId>.ir.json (.tmp then rename)
  fs.mkdirSync(genDir, { recursive: true });
  const tmpIrFile = path.join(genDir, `${flowId}.ir.json.tmp`);
  fs.writeFileSync(tmpIrFile, JSON.stringify(ir, null, 2), 'utf8');
  fs.renameSync(tmpIrFile, targetIrFile);

  return ir;
}
