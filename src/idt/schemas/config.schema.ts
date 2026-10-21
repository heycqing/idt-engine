import { z } from 'zod';

export const IdtConfigSchema = z.object({
  pageGlobs: z.array(z.string()).min(1),
  localeFiles: z.array(z.string()).default([]),
  routerGlobs: z.array(z.string()).default([]),
  // 去哪些目录下找带 idt 字段的 package.json。缺省 apps/*、packages/*。
  projectGlobs: z.array(z.string()).optional(),
});

export type IdtConfig = z.infer<typeof IdtConfigSchema>;
