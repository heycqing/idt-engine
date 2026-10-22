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

export const StageSchema = z.object({
  stageIndex: z.number().int().nonnegative(),
  stageName: z.string().min(1),
  routePattern: z.string().min(1),
  actions: z.array(ActionSchema),
  invariants: z.object({
    network: z.array(NetworkInvariantSchema).default([]),
    routeGuard: RouteGuardSchema.optional(),
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
export type Action = z.infer<typeof ActionSchema>;
export type NetworkInvariant = z.infer<typeof NetworkInvariantSchema>;
export type RouteGuard = z.infer<typeof RouteGuardSchema>;
export type Stage = z.infer<typeof StageSchema>;
export type StateTransitionIR = z.infer<typeof StateTransitionIRSchema>;
