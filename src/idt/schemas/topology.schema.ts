import { z } from 'zod';

export const RouteTransitionSchema = z.object({
  targetRoute: z.string().min(1),
  triggerType: z.enum(['CLICK', 'SUBMIT', 'PROGRAMMATIC']),
  triggerElementText: z.string().optional(),
  codeSlice: z.string(),
});

export const RouteTopologyNodeSchema = z.object({
  path: z.string().min(1),
  filePath: z.string().min(1),
  title: z.string(),
  semanticKeywords: z.array(z.string()),
  dynamicParams: z.array(z.string()),
  transitions: z.array(RouteTransitionSchema),
});

export const ProjectTopologySchema = z.object({
  version: z.literal('1.0.0'),
  generatedAt: z.string(),
  sourceDigest: z.string().length(64),
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

export type RouteTransition = z.infer<typeof RouteTransitionSchema>;
export type RouteTopologyNode = z.infer<typeof RouteTopologyNodeSchema>;
export type ProjectTopology = z.infer<typeof ProjectTopologySchema>;
export type SemanticIndexEntry = z.infer<typeof SemanticIndexEntrySchema>;
export type SemanticIndex = z.infer<typeof SemanticIndexSchema>;
