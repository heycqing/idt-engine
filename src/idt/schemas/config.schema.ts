import { z } from 'zod';

export const DEFAULT_DEFERRED_CONTAINERS = [
  'van-popup',
  'van-dialog',
  'van-action-sheet',
  'van-sheet',
  'van-overlay',
];

export const VerifyWarningExceptionSchema = z.object({
  project: z.string().min(1),
  flowId: z.string().regex(/^flow_[a-f0-9]{10}$/),
  code: z.literal('weak-assertion'),
  reason: z.string().min(1),
}).strict();

export type VerifyWarningException = z.infer<typeof VerifyWarningExceptionSchema>;

export const IdtConfigSchema = z.object({
  pageGlobs: z.array(z.string()).min(1),
  localeFiles: z.array(z.string()).default([]),
  routerGlobs: z.array(z.string()).default([]),
  // 去哪些目录下找带 idt 字段的 package.json。缺省 apps/*、packages/*。
  projectGlobs: z.array(z.string()).optional(),
  // 覆盖而非追加，空数组可显式关闭；不同宿主的 overlay 组件名没有可靠并集。
  deferredContainers: z.array(z.string().min(1)).optional(),
  verifyWarningExceptions: z.array(VerifyWarningExceptionSchema).default([]),
});

export type IdtConfig = z.infer<typeof IdtConfigSchema>;
