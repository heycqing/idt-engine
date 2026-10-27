import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TargetRoleSchema, AppearedRoleSchema } from '../../../src/idt/core/ir-schema.js';
import { PageElementSchema } from '../../../src/idt/schemas/topology.schema.js';

// 这两个枚举被悄悄放宽过一次（dialog/alert 混进了 TargetRoleSchema），
// 后果是 schema 比提示词和提取器都松：模型可以产出 targetRole: "dialog"
// 这种点不了的东西。这条测试把对齐钉死。
describe('role enums stay aligned', () => {
  const targetRoles = TargetRoleSchema.options as readonly string[];
  const elementRoles = (PageElementSchema.shape.role as any).options as readonly string[];
  const appearedRoles = AppearedRoleSchema.options as readonly string[];

  it('targetRole and the extractor element role are the same set', () => {
    assert.deepEqual([...targetRoles].sort(), [...elementRoles].sort());
  });

  it('the prompt lists exactly the targetRole values', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/idt/core/ir-compiler.ts', 'utf8');
    const line = src.split(/\r?\n/).find((l) => l.includes('"targetRole"'));
    assert.ok(line, '提示词里应当有一行列出 targetRole 的取值');
    for (const role of targetRoles) {
      assert.ok(line!.includes(`"${role}"`), `提示词漏了 role: ${role}`);
    }
  });

  it('appearedRole is a strict superset — dialogs appear but cannot be clicked', () => {
    for (const role of targetRoles) {
      assert.ok(appearedRoles.includes(role), `appearedRole 应当包含 ${role}`);
    }
    assert.ok(appearedRoles.length > targetRoles.length);
    assert.ok(appearedRoles.includes('dialog'));
    assert.equal(targetRoles.includes('dialog'), false, 'dialog 不能是动作目标');
  });
});
