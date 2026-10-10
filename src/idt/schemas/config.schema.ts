import { z } from 'zod';

export const IdtConfigSchema = z.object({
  pageGlobs: z.array(z.string()).min(1),
  localeFiles: z.array(z.string()).default([]),
});

export type IdtConfig = z.infer<typeof IdtConfigSchema>;
