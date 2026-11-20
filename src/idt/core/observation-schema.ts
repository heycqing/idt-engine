import { z } from 'zod';
import {
  ActionSchema,
  NetworkInvariantSchema,
  RouteGuardSchema,
  StageSchema,
  StateTransitionIRSchema,
} from './ir-schema.js';

const NonemptyString = z.string().min(1);

export const ObservedActionSchema = z.object({
  sequence: z.number().int().nonnegative(),
  sourceType: NonemptyString,
  description: NonemptyString,
  beforeUrl: NonemptyString,
  afterUrl: NonemptyString,
  hitSelector: NonemptyString.optional(),
  targetRole: NonemptyString.optional(),
  targetName: NonemptyString.optional(),
  inputValue: z.string().optional(),
  appearedElements: z.array(z.object({
    role: NonemptyString.optional(),
    name: NonemptyString.optional(),
    selector: NonemptyString.optional(),
    text: z.string().optional(),
  }).strict()),
  network: z.array(z.object({
    method: NonemptyString,
    url: NonemptyString,
    status: z.number().int().min(100).max(599).optional(),
  }).strict()),
  unresolved: z.array(NonemptyString),
}).strict();

export const ObservationDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  project: NonemptyString,
  route: z.string().regex(/^\/(?!\/)/),
  intent: NonemptyString,
  createdAt: z.string().datetime({ offset: true }),
  provider_status: z.enum(['success', 'timeout', 'error']).optional(),
  actions: z.array(ObservedActionSchema),
  unresolved: z.array(NonemptyString),
}).strict();

export const NetworkEvidenceAllowanceSchema = z.object({
  method: z.literal('GET'),
  url: z.string().url(),
}).strict();

export const ObservationCandidateSchema = StateTransitionIRSchema.extend({
  setup: StateTransitionIRSchema.shape.setup.strict(),
  stages: z.array(StageSchema.extend({
    actions: z.array(ActionSchema.strict()),
    invariants: StageSchema.shape.invariants.extend({
      network: z.array(NetworkInvariantSchema.strict()).default([]),
      routeGuard: RouteGuardSchema.strict().optional(),
    }).strict(),
  }).strict()).min(1),
}).strict();

export type ObservedAction = z.infer<typeof ObservedActionSchema>;
export type ObservationDocument = z.infer<typeof ObservationDocumentSchema>;
export type NetworkEvidenceAllowance = z.infer<typeof NetworkEvidenceAllowanceSchema>;
