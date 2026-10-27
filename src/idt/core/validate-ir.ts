import fs from 'node:fs';
import path from 'node:path';
import {
  StateTransitionIRSchema,
  type StateTransitionIR,
} from './ir-schema.js';
import { findEvidenceGaps } from './action-evidence.js';

export interface ValidateIrOptions {
  projectRoot: string;
  routePath: string[];
  proseCase?: string;
  mode: 'gen' | 'emit';
  fileStem?: string;
  /** 默认 true。compileIntent 传 false：先把 IR 落盘，证据的事单独报。 */
  checkEvidence?: boolean;
}

export class ValidationError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'ValidationError';
    this.exitCode = exitCode;
  }
}

const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function validateIr(ir: StateTransitionIR, options: ValidateIrOptions): void {
  // Validate schema
  const parsed = StateTransitionIRSchema.safeParse(ir);
  if (!parsed.success) {
    throw new ValidationError(`IR schema validation failed: ${parsed.error.message}`, 2);
  }

  // 1. Mode check
  if (options.mode === 'emit') {
    if (!/^flow_[a-f0-9]{10}$/.test(ir.flowId)) {
      throw new ValidationError(
        `flowId "${ir.flowId}" does not match pattern /^flow_[a-f0-9]{10}$/`,
        2
      );
    }
    if (options.fileStem !== undefined && ir.flowId !== options.fileStem) {
      throw new ValidationError(
        `flowId "${ir.flowId}" does not match fileStem "${options.fileStem}"`,
        2
      );
    }
  }

  // 2. unresolved must be empty
  if (ir.unresolved && ir.unresolved.length > 0) {
    throw new ValidationError(
      `IR contains unresolved items: ${ir.unresolved.join(', ')}`,
      2
    );
  }

  // 3. initialRoute must equal routePath[0]
  if (ir.initialRoute !== options.routePath[0]) {
    throw new ValidationError(
      `initialRoute "${ir.initialRoute}" does not match routePath[0] "${options.routePath[0]}"`,
      2
    );
  }

  // Any initialRoute or stage.routePattern containing ':' -> exitCode 2, message containing '具体参数'
  if (ir.initialRoute.includes(':')) {
    throw new ValidationError(
      `initialRoute "${ir.initialRoute}" contains dynamic parameter ":" - 需要具体参数`,
      2
    );
  }

  for (const stage of ir.stages) {
    if (stage.routePattern.includes(':')) {
      throw new ValidationError(
        `stage.routePattern "${stage.routePattern}" contains dynamic parameter ":" - 需要具体参数`,
        2
      );
    }
  }

  // 4. stages.length must equal routePath.length
  if (ir.stages.length !== options.routePath.length) {
    throw new ValidationError(
      `stages length (${ir.stages.length}) does not match routePath length (${options.routePath.length})`,
      2
    );
  }

  for (let i = 0; i < ir.stages.length; i++) {
    const stage = ir.stages[i];
    if (stage.stageIndex !== i) {
      throw new ValidationError(
        `stage at index ${i} has stageIndex ${stage.stageIndex}, expected ${i}`,
        2
      );
    }
    if (stage.routePattern !== options.routePath[i]) {
      throw new ValidationError(
        `stage[${i}].routePattern "${stage.routePattern}" does not match routePath[${i}] "${options.routePath[i]}"`,
        2
      );
    }
  }

  // 5. FILL and SELECT must have inputValue
  for (const stage of ir.stages) {
    for (const action of stage.actions) {
      if (action.actionType === 'FILL' || action.actionType === 'SELECT') {
        if (action.inputValue === undefined || action.inputValue === null) {
          throw new ValidationError(
            `Action ${action.actionType} on "${action.targetName}" in stage "${stage.stageName}" requires inputValue`,
            2
          );
        }
      }
    }
  }

  // 6. Interactive stages require network, real navigation, or a DOM delta.
  if (options.checkEvidence !== false) {
    const gap = findEvidenceGaps(ir)[0];
    if (gap) {
      throw new ValidationError(
        `Stage "${gap.stageName}" contains CLICK/CHECK/SELECT action but has no network invariant, routeGuard navigating to a different route, or domDelta`,
        2
      );
    }
  }

  // 7. storageStatePath checks
  if (ir.setup?.storageStatePath) {
    const storagePath = ir.setup.storageStatePath;
    if (path.isAbsolute(storagePath)) {
      throw new ValidationError(
        `storageStatePath must be a relative path: "${storagePath}"`,
        2
      );
    }
    const resolved = path.resolve(options.projectRoot, storagePath);
    const rel = path.relative(options.projectRoot, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new ValidationError(
        `storageStatePath resolves outside projectRoot: "${storagePath}"`,
        2
      );
    }
    if (!fs.existsSync(resolved)) {
      throw new ValidationError(
        `storageStatePath file does not exist: "${resolved}"`,
        2
      );
    }
  }

  // 8. targetUrlPattern RegExp checks
  for (const stage of ir.stages) {
    if (stage.invariants.routeGuard?.targetUrlPattern) {
      try {
        new RegExp(stage.invariants.routeGuard.targetUrlPattern);
      } catch (err: any) {
        throw new ValidationError(
          `Invalid targetUrlPattern regex: "${stage.invariants.routeGuard.targetUrlPattern}": ${err.message}`,
          2
        );
      }
    }
  }

  // 9. readyRole and readyName must be both present or both absent
  for (const stage of ir.stages) {
    const guard = stage.invariants.routeGuard;
    if (guard) {
      const hasRole = guard.readyRole !== undefined;
      const hasName = guard.readyName !== undefined;
      if (hasRole !== hasName) {
        throw new ValidationError(
          `readyRole and readyName in routeGuard of stage "${stage.stageName}" must be both present or both absent`,
          2
        );
      }
    }
  }

  // 10. assertResponseFields key validation
  for (const stage of ir.stages) {
    for (const net of stage.invariants.network) {
      if (net.assertResponseFields) {
        for (const key of Object.keys(net.assertResponseFields)) {
          const parts = key.split('.');
          if (
            parts.length === 0 ||
            parts.some((p) => !IDENTIFIER_PATTERN.test(p))
          ) {
            throw new ValidationError(
              `Invalid assertResponseFields key "${key}": every dot-separated segment must match /^[A-Za-z_$][A-Za-z0-9_$]*$/`,
              2
            );
          }
        }
      }
    }
  }

  // 11. proseCase login / storageState rule
  if (options.proseCase) {
    const mentionsAuth =
      options.proseCase.includes('登录') ||
      options.proseCase.includes('storageState');
    if (mentionsAuth) {
      const hasStorage = Boolean(ir.setup?.storageStatePath);
      const hasLoginRoute = ir.stages.some((s) =>
        s.routePattern.toLowerCase().includes('login')
      );
      if (!hasStorage && !hasLoginRoute) {
        throw new ValidationError(
          `proseCase mentions login or storageState, but IR lacks storageStatePath and no routePattern contains "login" (缺少登录态)`,
          2
        );
      }
    }
  }
}
