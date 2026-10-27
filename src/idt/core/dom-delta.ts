import { parseAriaSnapshot } from './aria-snapshot.js';

export interface DomDeltaCandidate {
  role: string;
  name: string;
}

export function diffAriaSnapshots(
  before: string,
  after: string,
): DomDeltaCandidate[] {
  const beforeKeys = new Set(
    parseAriaSnapshot(before).map(({ role, name }) => `${role}\0${name}`),
  );
  const appearedKeys = new Set<string>();
  const candidates: DomDeltaCandidate[] = [];

  for (const element of parseAriaSnapshot(after)) {
    if (!element.name) continue;
    const key = `${element.role}\0${element.name}`;
    if (beforeKeys.has(key) || appearedKeys.has(key)) continue;
    appearedKeys.add(key);
    candidates.push(element);
  }

  return candidates;
}
