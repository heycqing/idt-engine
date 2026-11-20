import { ProjectTopologySchema, type ProjectTopology } from '../schemas/topology.schema.js';
import { AppearedRoleSchema, NetworkInvariantSchema, RouteGuardSchema, TargetRoleSchema, type Action, type Stage, type StateTransitionIR } from './ir-schema.js';
import { flowIdFromIntent } from './intent.js';
import { fromBrowserUrl, toBrowserUrl } from './route-url-pure.js';
import {
  NetworkEvidenceAllowanceSchema,
  ObservationCandidateSchema,
  ObservationDocumentSchema,
  type NetworkEvidenceAllowance,
  type ObservationDocument,
  type ObservedAction,
} from './observation-schema.js';

const ACTION_TYPES = {
  click: 'CLICK', input: 'FILL', fill: 'FILL', select: 'SELECT', check: 'CHECK',
} as const;

function hasRoute(topology: ProjectTopology, route: string): boolean {
  if (Object.hasOwn(topology.routes, route)) return true;
  return Object.keys(topology.routes).some((r) => r.toLowerCase() === route.toLowerCase());
}

function routeFromUrl(value: string, topology: ProjectTopology): { route: string; origin: string; url: string } | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
  const route = fromBrowserUrl(value, topology.router);
  return route ? { route, origin: url.origin, url: url.href } : undefined;
}

function compileAction(observed: ObservedAction, route: string, topology: ProjectTopology, unresolved: string[]): Action | undefined {
  const fail = (reason: string) => { unresolved.push(`Action ${observed.sequence}: ${reason}`); };
  const sourceType = observed.sourceType.toLowerCase();
  if (!Object.hasOwn(ACTION_TYPES, sourceType)) {
    fail(`unsupported action ${observed.sourceType}: ${observed.description}`);
    return undefined;
  }
  const actionType = ACTION_TYPES[sourceType as keyof typeof ACTION_TYPES];
  const role = TargetRoleSchema.safeParse(observed.targetRole);
  const matches = topology.routes[route]?.elements.filter((element) =>
    element.role === observed.targetRole && element.name === observed.targetName,
  ) ?? [];
  if (!role.success || !observed.targetName || matches.length !== 1 || matches[0].dynamic || matches[0].dataScoped) {
    fail('exact semantic locator must have one stable role/name match in topology; a hit selector is insufficient');
    return undefined;
  }
  if ((actionType === 'FILL' || actionType === 'SELECT') && observed.inputValue === undefined) {
    fail(`${actionType} requires an observed inputValue`);
    return undefined;
  }
  return {
    actionType, targetRole: role.data, targetName: observed.targetName,
    ...(observed.inputValue !== undefined ? { inputValue: observed.inputValue } : {}),
    timeoutMs: 5000, triggersRequest: false,
  };
}

function evidenceFor(observed: ObservedAction, beforeRoute: string, afterRoute: string | undefined, allowlist: NetworkEvidenceAllowance[], unresolved: string[]): Stage['invariants'] | undefined {
  if (afterRoute && beforeRoute !== afterRoute) {
    const routeGuard = RouteGuardSchema.safeParse({ targetUrlPattern: `^${afterRoute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$` });
    if (!routeGuard.success) {
      unresolved.push(`Action ${observed.sequence}: route pattern cannot be represented by the current IR schema`);
      return undefined;
    }
    return { network: [], routeGuard: routeGuard.data };
  }
  const semantic = observed.appearedElements.filter((element) =>
    AppearedRoleSchema.safeParse(element.role).success && Boolean(element.name),
  );
  if (semantic.length > 1) {
    unresolved.push(`Action ${observed.sequence}: ambiguous semantic DOM evidence`);
    return undefined;
  }
  if (semantic.length === 1) {
    return {
      network: [],
      domDelta: { appearedRole: AppearedRoleSchema.parse(semantic[0].role), appearedName: semantic[0].name! },
    };
  }
  const approved = observed.network.filter((request) =>
    request.method === 'GET' && request.status !== undefined
    && allowlist.some((entry) => entry.method === request.method && entry.url === request.url),
  );
  if (approved.length !== 1) return undefined;
  const invariant = NetworkInvariantSchema.safeParse({
    method: 'GET', urlPattern: approved[0].url, exactUrl: approved[0].url, expectedStatus: approved[0].status!, responseType: 'none',
  });
  if (!invariant.success) {
    unresolved.push(`Action ${observed.sequence}: exact network URL cannot be represented by the current IR schema`);
    return undefined;
  }
  return { network: [invariant.data] };
}

export function compileObservation(input: {
  document: ObservationDocument;
  topology: ProjectTopology;
  networkAllowlist?: NetworkEvidenceAllowance[];
}): { candidate: StateTransitionIR; unresolved: string[] } {
  const document = ObservationDocumentSchema.parse(input.document);
  const topology = ProjectTopologySchema.parse(input.topology);
  const allowlist = NetworkEvidenceAllowanceSchema.array().parse(input.networkAllowlist ?? []);
  const unresolved = [...document.unresolved];
  if (topology.project && topology.project !== document.project) unresolved.push('Observation project does not match topology project');
  if (!Object.hasOwn(topology.routes, document.route)) unresolved.push(`Unknown initial route ${document.route}`);
  if (document.actions.length === 0) unresolved.push('Observation contains no actions or hard evidence');

  let expectedRoute = document.route;
  let expectedUrl: string | undefined;
  let previousSequence = -1;
  const stages = document.actions.map((observed, stageIndex): Stage => {
    const label = `Action ${observed.sequence}`;
    unresolved.push(...observed.unresolved.map((item) => `${label}: ${item}`));
    if (observed.sequence <= previousSequence) unresolved.push(`${label}: sequence must be strictly increasing`);
    previousSequence = observed.sequence;
    const before = routeFromUrl(observed.beforeUrl, topology);
    const after = routeFromUrl(observed.afterUrl, topology);
    if (before?.route.includes(':') || after?.route.includes(':')) {
      unresolved.push(`${label}: dynamic route parameters are unsupported by the current emitter`);
    }
    if (stageIndex === 0) {
      const expectedInitialUrl = before && new URL(toBrowserUrl(document.route, topology.router), before.origin).href;
      if (!before || before.url !== expectedInitialUrl) unresolved.push(`${label}: initial URL differs from the deterministic page.goto URL`);
    }
    if (!before || !hasRoute(topology, before.route)) unresolved.push(`${label}: unknown or invalid before route`);
    if (!after || !hasRoute(topology, after.route)) unresolved.push(`${label}: unknown or invalid after route`);
    if (before?.origin !== after?.origin) unresolved.push(`${label}: cross-origin navigation is unsupported`);
    if (before?.route !== expectedRoute) unresolved.push(`${label}: before route is disconnected from the preceding observation`);
    if (expectedUrl !== undefined && before?.url !== expectedUrl) unresolved.push(`${label}: before URL is disconnected from the preceding after URL`);
    const route = before?.route ?? expectedRoute;
    const action = compileAction(observed, route, topology, unresolved);
    const invariants = action ? evidenceFor(observed, route,
      after && hasRoute(topology, after.route) && before?.origin === after.origin ? after.route : undefined,
      allowlist, unresolved,
    ) : undefined;
    if (action && !invariants) unresolved.push(`${label}: no unique hard evidence (navigation, semantic DOM appearance, or allowlisted network)`);
    if (action && invariants?.network.length) action.triggersRequest = true;
    expectedRoute = after?.route ?? route;
    expectedUrl = after?.url;
    return {
      stageIndex, stageName: observed.description, routePattern: route,
      actions: action ? [action] : [], invariants: invariants ?? { network: [] },
    };
  });
  if (stages.length === 0) stages.push({ stageIndex: 0, stageName: document.intent, routePattern: document.route, actions: [], invariants: { network: [] } });
  const candidate = ObservationCandidateSchema.parse({
    flowId: flowIdFromIntent(document.intent), intent: document.intent,
    oracle: 'regression-lock', description: document.intent, initialRoute: document.route,
    setup: { notes: [] }, unresolved, stages,
  });
  return { candidate, unresolved: candidate.unresolved };
}
