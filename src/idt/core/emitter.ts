import fs from 'node:fs';
import path from 'node:path';
import {
  StateTransitionIRSchema,
  type Action,
  type StateTransitionIR,
} from './ir-schema.js';
import { validateIr } from './validate-ir.js';
import { findTriggerActionIndex } from './action-order.js';
import { findEvidenceGaps } from './action-evidence.js';
import {
  DEFAULT_ROUTER_URL_OPTIONS,
  readRouterOptions,
  toBrowserUrl,
  toGuardPattern,
  type RouterUrlOptions,
} from './route-url.js';

export class EmitterError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'EmitterError';
    this.exitCode = exitCode;
  }
}

const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const FORBIDDEN_TOKENS = [
  'networkidle',
  'toHaveScreenshot',
  'waitForTimeout',
  'waitForLoadState',
  'domcontentloaded',
  'localhost',
  'fullPage',
  'enableVisualSnapshot',
];

function renderNamedLocator(role: string, name: string): string {
  const nameStr = JSON.stringify(name);
  return role === 'text'
    ? `page.getByText(${nameStr}, { exact: true })`
    : `page.getByRole(${JSON.stringify(role)}, { name: ${nameStr} })`;
}

export function emitSpec(
  ir: unknown,
  router: RouterUrlOptions = DEFAULT_ROUTER_URL_OPTIONS,
): string {
  const parsed = StateTransitionIRSchema.safeParse(ir);
  if (!parsed.success) {
    throw new EmitterError(
      `IR schema validation failed: ${parsed.error.message}`,
      2
    );
  }
  const validIr: StateTransitionIR = parsed.data;

  // 1. unresolved is non-empty
  if (validIr.unresolved && validIr.unresolved.length > 0) {
    throw new EmitterError(
      `IR contains unresolved items: ${validIr.unresolved.join(', ')}`,
      2
    );
  }

  // 2. initialRoute or any routePattern contains ':' -> exitCode 2 with message containing "具体参数"
  if (validIr.initialRoute.includes(':')) {
    throw new EmitterError(
      `initialRoute "${validIr.initialRoute}" contains dynamic parameter ":" - 需要具体参数`,
      2
    );
  }
  for (const stage of validIr.stages) {
    if (stage.routePattern.includes(':')) {
      throw new EmitterError(
        `stage.routePattern "${stage.routePattern}" contains dynamic parameter ":" - 需要具体参数`,
        2
      );
    }
  }

  // 3. stages[i].stageIndex === i and stages[0].routePattern === initialRoute
  if (validIr.stages[0].routePattern !== validIr.initialRoute) {
    throw new EmitterError(
      `stages[0].routePattern "${validIr.stages[0].routePattern}" does not match initialRoute "${validIr.initialRoute}"`,
      2
    );
  }
  for (let i = 0; i < validIr.stages.length; i++) {
    if (validIr.stages[i].stageIndex !== i) {
      throw new EmitterError(
        `stage at index ${i} has stageIndex ${validIr.stages[i].stageIndex}, expected ${i}`,
        2
      );
    }
  }

  // 4. FILL and SELECT must have inputValue (empty string is allowed)
  for (const stage of validIr.stages) {
    for (const action of stage.actions) {
      if (action.actionType === 'FILL' || action.actionType === 'SELECT') {
        if (action.inputValue === undefined || action.inputValue === null) {
          throw new EmitterError(
            `Action ${action.actionType} on "${action.targetName}" requires inputValue`,
            2
          );
        }
      }
    }
  }

  // 5. Interactive stages require network, real navigation, or a DOM delta.
  const evidenceGap = findEvidenceGaps(validIr)[0];
  if (evidenceGap) {
    throw new EmitterError(
      `Stage "${evidenceGap.stageName}" contains CLICK/CHECK/SELECT action but has no network invariant, routeGuard navigating to a different route, or domDelta`,
      2
    );
  }

  // 6. readyRole and readyName both present or both absent
  for (const stage of validIr.stages) {
    const guard = stage.invariants.routeGuard;
    if (guard) {
      const hasRole = guard.readyRole !== undefined;
      const hasName = guard.readyName !== undefined;
      if (hasRole !== hasName) {
        throw new EmitterError(
          `readyRole and readyName in routeGuard must be both present or both absent`,
          2
        );
      }
    }
  }

  // 7. targetUrlPattern can new RegExp(pattern)
  for (const stage of validIr.stages) {
    if (stage.invariants.routeGuard?.targetUrlPattern) {
      try {
        new RegExp(stage.invariants.routeGuard.targetUrlPattern);
      } catch (err: any) {
        throw new EmitterError(
          `Invalid targetUrlPattern regex: "${stage.invariants.routeGuard.targetUrlPattern}": ${err.message}`,
          2
        );
      }
    }
  }

  // 8. assertResponseFields key validation
  for (const stage of validIr.stages) {
    for (const net of stage.invariants.network) {
      if (net.assertResponseFields) {
        for (const key of Object.keys(net.assertResponseFields)) {
          const parts = key.split('.');
          if (
            parts.length === 0 ||
            parts.some((p) => !IDENTIFIER_PATTERN.test(p))
          ) {
            throw new EmitterError(
              `Invalid assertResponseFields key "${key}": every segment must match /^[A-Za-z_$][A-Za-z0-9_$]*$/`,
              2
            );
          }
        }
      }
    }
  }

  const lines: string[] = [];

  // Header lines
  lines.push(`// Generated by IDT. Source: ${validIr.flowId}.ir.json`);
  lines.push(`// Oracle: ${validIr.oracle}`);
  lines.push(
    `// Edit the IR, then run: pnpm idt:emit tests/e2e/generated/${validIr.flowId}.ir.json`
  );
  lines.push(`import { test, expect } from '@playwright/test';`);
  lines.push('');

  // Storage state configuration
  if (validIr.setup?.storageStatePath) {
    const posixStorage = validIr.setup.storageStatePath.replace(/\\/g, '/');
    lines.push(`test.use({ storageState: ${JSON.stringify(posixStorage)} });`);
    lines.push('');
  }

  // Test definition
  lines.push(
    `test(${JSON.stringify(validIr.description)}, async ({ page }) => {`
  );
  lines.push(
    `  await page.goto(${JSON.stringify(toBrowserUrl(validIr.initialRoute, router))});`,
  );

  let responseCounter = 0;

  for (const stage of validIr.stages) {
    const actions = stage.actions;
    const network = stage.invariants.network;
    const routeGuard = stage.invariants.routeGuard;

    // Trigger action determination
    const triggerIndex = findTriggerActionIndex(actions);

    const triggerAction = triggerIndex >= 0 ? actions[triggerIndex] : null;
    const triggerTimeout = triggerAction ? triggerAction.timeoutMs : 5000;

    const renderActionExpr = (action: Action): string => {
      const timeout = action.timeoutMs;
      // text 是伪 role：没有 ARIA role 但带静态文本的可点元素。exact 避免
      // 「全部」命中「全部撤单」；不加 .first()，文本重复就让 strict mode 报错。
      const locator = renderNamedLocator(action.targetRole, action.targetName);
      switch (action.actionType) {
        case 'CLICK':
          return `${locator}.click({ timeout: ${timeout} })`;
        case 'FILL':
          return `${locator}.fill(${JSON.stringify(action.inputValue ?? '')}, { timeout: ${timeout} })`;
        case 'CHECK':
          return `${locator}.check({ timeout: ${timeout} })`;
        case 'SELECT':
          return `${locator}.selectOption(${JSON.stringify(action.inputValue ?? '')}, { timeout: ${timeout} })`;
      }
    };

    // Prior actions
    for (let i = 0; i < actions.length; i++) {
      if (i !== triggerIndex) {
        lines.push(`  await ${renderActionExpr(actions[i])};`);
      }
    }

    // Network calls and trigger action
    if (network && network.length > 0) {
      const stageRespVars: string[] = [];
      for (let i = 0; i < network.length; i++) {
        stageRespVars.push(`response${responseCounter + i}`);
      }
      responseCounter += network.length;

      lines.push(`  const [${stageRespVars.join(', ')}] = await Promise.all([`);
      for (const net of network) {
        lines.push(`    page.waitForResponse((res) =>`);
        lines.push(
          `      res.url().includes(${JSON.stringify(net.urlPattern)}) && res.request().method() === ${JSON.stringify(net.method)},`
        );
        lines.push(`      { timeout: ${triggerTimeout} },`);
        lines.push(`    ),`);
      }
      if (triggerAction) {
        lines.push(`    ${renderActionExpr(triggerAction)},`);
      }
      lines.push(`  ]);`);

      // Network invariant assertions
      for (let i = 0; i < network.length; i++) {
        const net = network[i];
        const respVar = stageRespVars[i];
        lines.push(`  expect(${respVar}.status()).toBe(${net.expectedStatus});`);
        if (net.responseType === 'json') {
          const bodyVar = respVar.replace('response', 'body');
          lines.push(`  const ${bodyVar} = await ${respVar}.json();`);
          if (net.assertResponseFields) {
            for (const key of Object.keys(net.assertResponseFields)) {
              const val = net.assertResponseFields[key];
              lines.push(
                `  expect(${bodyVar}.${key}).toEqual(${JSON.stringify(val)});`
              );
            }
          }
        }
      }
    } else {
      if (triggerAction) {
        lines.push(`  await ${renderActionExpr(triggerAction)};`);
      }
    }

    const domDelta = stage.invariants.domDelta;
    if (domDelta) {
      let locator: string;
      if ('appearedSelector' in domDelta) {
        locator = `page.locator(${JSON.stringify(domDelta.appearedSelector)})`;
        if (domDelta.appearedText !== undefined) {
          locator += `.filter({ hasText: ${JSON.stringify(domDelta.appearedText)} })`;
        }
      } else {
        locator = renderNamedLocator(domDelta.appearedRole, domDelta.appearedName);
      }
      lines.push(
        `  await expect(${locator}).toBeVisible({ timeout: ${triggerTimeout} });`,
      );
    }

    // Route guard
    if (routeGuard) {
      const patternStr = JSON.stringify(
        toGuardPattern(routeGuard.targetUrlPattern, router),
      );
      lines.push(
        `  await page.waitForURL(new RegExp(${patternStr}), { timeout: ${triggerTimeout} });`
      );
      lines.push(`  await expect(page).toHaveURL(new RegExp(${patternStr}));`);
      if (routeGuard.readyRole && routeGuard.readyName) {
        lines.push(
          `  await expect(${renderNamedLocator(routeGuard.readyRole, routeGuard.readyName)}).toBeVisible();`
        );
      }
    }
  }

  lines.push('});');
  lines.push('');

  const result = lines.join('\n');

  for (const token of FORBIDDEN_TOKENS) {
    if (result.includes(token)) {
      throw new EmitterError(`Forbidden token in generated spec: ${token}`, 2);
    }
  }

  return result;
}

export function emitIrFile(
  projectRoot: string,
  irFilePath: string,
  router: RouterUrlOptions = readRouterOptions(projectRoot),
): { specPath: string; source: string } {
  const resolvedIrPath = path.isAbsolute(irFilePath)
    ? irFilePath
    : path.resolve(projectRoot, irFilePath);

  const baseName = path.basename(resolvedIrPath);
  if (!baseName.endsWith('.ir.json')) {
    throw new EmitterError(
      `File name must end with .ir.json: "${resolvedIrPath}"`,
      2
    );
  }

  if (!fs.existsSync(resolvedIrPath)) {
    throw new EmitterError(`IR file does not exist: "${resolvedIrPath}"`, 2);
  }

  let rawContent: string;
  try {
    rawContent = fs.readFileSync(resolvedIrPath, 'utf8');
  } catch (err: any) {
    throw new EmitterError(`Failed to read IR file: ${err.message}`, 2);
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawContent);
  } catch (err: any) {
    throw new EmitterError(`Invalid JSON: ${err.message}`, 2);
  }

  const parsed = StateTransitionIRSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new EmitterError(
      `IR schema validation failed: ${parsed.error.message}`,
      2
    );
  }
  const ir = parsed.data;

  const fileStem = baseName.slice(0, -'.ir.json'.length);
  const routePath = ir.stages.map((stage) => stage.routePattern);

  validateIr(ir, {
    projectRoot,
    routePath,
    mode: 'emit',
    fileStem,
  });

  const source = emitSpec(ir, router);

  const specDir = path.dirname(resolvedIrPath);
  const specPath = path.join(specDir, `${fileStem}.spec.ts`);
  const tmpPath = `${specPath}.tmp`;

  fs.writeFileSync(tmpPath, source, 'utf8');
  if (fs.existsSync(specPath)) {
    fs.unlinkSync(specPath);
  }
  fs.renameSync(tmpPath, specPath);

  return { specPath, source };
}
