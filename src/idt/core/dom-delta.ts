import { parseAriaSnapshot } from './aria-snapshot.js';

export interface DomDeltaCandidate {
  role: string;
  name: string;
}

/**
 * Playwright 会把相邻文案合成 text 节点。超过 24 字通常已是整页文案，
 * 三段以上的空白分词通常是多个区域拼接；两者都无法形成稳定的精确定位器。
 */
export function isUsableTextName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length <= 24 && trimmed.split(/\s+/).length < 3;
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
    if (element.role === 'text' && !isUsableTextName(element.name)) continue;
    const key = `${element.role}\0${element.name}`;
    if (beforeKeys.has(key) || appearedKeys.has(key)) continue;
    appearedKeys.add(key);
    candidates.push(element);
  }

  return candidates;
}
