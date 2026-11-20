import { z } from 'zod';

const SafePattern = /^[A-Za-z0-9_./:?*=^$()[\]|+\\-]{1,200}$/;

export const TargetRoleSchema = z.enum([
  // 伪 role：没有 ARIA role 但带静态文本的可点元素，用 getByText 定位
  'text',
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'heading',
  'tab',
]);

/**
 * 动作之后可能新出现的元素的 role。
 *
 * 比 TargetRoleSchema 宽：弹窗、吐司这类东西点不了、也不会进元素清单，
 * 但它们恰恰是「动作生效了」最直接的证据。两个枚举必须分开——把 dialog
 * 混进 TargetRoleSchema 会让模型可以产出 targetRole: "dialog" 这种点不了
 * 的东西，而提示词和提取器都只认 9 个 role。
 */
export const AppearedRoleSchema = z.enum([
  'text',
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'heading',
  'tab',
  'dialog',
  'alertdialog',
  'alert',
  'status',
  'tooltip',
]);

export const ActionSchema = z.object({
  actionType: z.enum(['CLICK', 'FILL', 'SELECT', 'CHECK']),
  targetRole: TargetRoleSchema,
  targetName: z.string().min(1),
  inputValue: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(30000).default(5000),
  triggersRequest: z.boolean().default(false),
});

export const NetworkInvariantSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']),
  urlPattern: z.string().min(1).max(200),
  exactUrl: z.string().url().max(200).optional(),
  expectedStatus: z.number().int().min(100).max(599).default(200),
  responseType: z.enum(['json', 'none']).default('json'),
  assertResponseFields: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
});

export const RouteGuardSchema = z.object({
  targetUrlPattern: z.string().regex(SafePattern),
  readyRole: TargetRoleSchema.optional(),
  readyName: z.string().min(1).optional(),
});

export const DomDeltaSchema = z.union([
  z.object({
    appearedRole: AppearedRoleSchema,
    appearedName: z.string().min(1),
  }).strict(),
  z.object({
    appearedSelector: z.string().min(1),
    appearedText: z.string().optional(),
  }).strict(),
]);

export const StageSchema = z.object({
  stageIndex: z.number().int().nonnegative(),
  stageName: z.string().min(1),
  routePattern: z.string().min(1),
  actions: z.array(ActionSchema),
  invariants: z.object({
    network: z.array(NetworkInvariantSchema).default([]),
    routeGuard: RouteGuardSchema.optional(),
    domDelta: DomDeltaSchema.optional(),
  }),
});

export const StateTransitionIRSchema = z.object({
  flowId: z.string().regex(/^flow_[a-f0-9]{10}$/),
  intent: z.string().min(1),
  oracle: z.enum(['regression-lock', 'prose-case']),
  description: z.string().min(1),
  initialRoute: z.string().regex(/^\/(?!\/)/),
  setup: z.object({
    storageStatePath: z.string().optional(),
    notes: z.array(z.string()).default([]),
  }),
  unresolved: z.array(z.string()).default([]),
  stages: z.array(StageSchema).min(1),
});

export type TargetRole = z.infer<typeof TargetRoleSchema>;
export type AppearedRole = z.infer<typeof AppearedRoleSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type NetworkInvariant = z.infer<typeof NetworkInvariantSchema>;
export type RouteGuard = z.infer<typeof RouteGuardSchema>;
export type DomDelta = z.infer<typeof DomDeltaSchema>;
export type Stage = z.infer<typeof StageSchema>;
export type StateTransitionIR = z.infer<typeof StateTransitionIRSchema>;
