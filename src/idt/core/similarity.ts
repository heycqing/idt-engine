export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) {
    prev[j] = j;
  }

  for (let i = 1; i <= m; i++) {
    const curr = new Array<number>(n + 1);
    curr[0] = i;
    const aChar = a[i - 1];
    for (let j = 1; j <= n; j++) {
      if (aChar === b[j - 1]) {
        curr[j] = prev[j - 1];
      } else {
        curr[j] = Math.min(
          prev[j] + 1,     // deletion
          curr[j - 1] + 1, // insertion
          prev[j - 1] + 1  // substitution
        );
      }
    }
    prev = curr;
  }

  return prev[n];
}

export function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

export function scoreAcceptable(distance: number, maxLen: number): boolean {
  if (maxLen === 0) {
    return distance === 0;
  }
  return distance * 100 <= maxLen * 28;
}

export type ChooseReplacementResult =
  | { ok: true; name: string }
  | { ok: false; reason: 'low' | 'gap' | 'empty' };

export function chooseReplacement(
  currentName: string,
  names: string[],
): ChooseReplacementResult {
  const uniqueNames = Array.from(new Set(names));
  if (uniqueNames.length === 0) {
    return { ok: false, reason: 'empty' };
  }

  const scored = uniqueNames.map((name) => {
    const dist = levenshtein(currentName, name);
    const maxLen = Math.max(currentName.length, name.length);
    const score = maxLen === 0 ? 1 : 1 - dist / maxLen;
    return { name, dist, maxLen, score };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.name.localeCompare(b.name);
  });

  const best = scored[0];
  if (!scoreAcceptable(best.dist, best.maxLen)) {
    return { ok: false, reason: 'low' };
  }

  if (scored.length >= 2) {
    const second = scored[1];
    const diff = best.score - second.score;
    if (diff < 0.05 - 1e-9) {
      return { ok: false, reason: 'gap' };
    }
  }

  return { ok: true, name: best.name };
}
