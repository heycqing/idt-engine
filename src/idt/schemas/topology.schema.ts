import { z } from 'zod';

export const RouteTransitionSchema = z.object({
  targetRoute: z.string().min(1),
  triggerType: z.enum(['CLICK', 'SUBMIT', 'PROGRAMMATIC']),
  triggerElementText: z.string().optional(),
  codeSlice: z.string(),
});

export const PageElementSchema = z.object({
  role: z.enum([
    'text',
    'button',
    'link',
    'textbox',
    'checkbox',
    'radio',
    'combobox',
    'heading',
    'tab',
  ]),
  name: z.string().min(1).optional(),
  dynamic: z.literal(true).optional(),
  tag: z.string().min(1).optional(),
});

export const RouteTopologyNodeSchema = z.object({
  path: z.string().min(1),
  filePath: z.string().min(1),
  title: z.string(),
  semanticKeywords: z.array(z.string()),
  dynamicParams: z.array(z.string()),
  transitions: z.array(RouteTransitionSchema),
  // 可选：拓扑生成于本字段之前的宿主读进来是空数组，产物不作废。
  elements: z.array(PageElementSchema).default([]),
});

export const ProjectTopologySchema = z.object({
  version: z.literal('1.0.0'),
  generatedAt: z.string(),
  sourceDigest: z.string().length(64),
  // 多项目宿主里标明这份拓扑属于哪个项目。单项目和旧产物没有这个字段。
  project: z.string().min(1).optional(),
  // 路由模式。缺失按 history 读，旧产物不作废。
  router: z
    .object({
      mode: z.enum(['hash', 'history']),
      base: z.string().min(1).optional(),
      // 每次导航都带上的查询串，比如宿主的免登录渠道旁路
      query: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  routes: z.record(z.string(), RouteTopologyNodeSchema),
});

export const SemanticIndexEntrySchema = z.object({
  keyword: z.string(),
  route: z.string(),
  kind: z.enum(['text', 'i18n', 'title']),
});

export const SemanticIndexSchema = z.object({
  version: z.literal('1.0.0'),
  sourceDigest: z.string().length(64),
  entries: z.array(SemanticIndexEntrySchema),
});

export type PageElement = z.infer<typeof PageElementSchema>;
export type RouteTransition = z.infer<typeof RouteTransitionSchema>;
export type RouteTopologyNode = z.infer<typeof RouteTopologyNodeSchema>;
export type ProjectTopology = z.infer<typeof ProjectTopologySchema>;
export type SemanticIndexEntry = z.infer<typeof SemanticIndexEntrySchema>;
export type SemanticIndex = z.infer<typeof SemanticIndexSchema>;
