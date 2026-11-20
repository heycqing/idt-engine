import path from 'node:path';

export function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

export function toRoutePattern(projectRoot: string, filePath: string): string | null {
  const relative = toPosixPath(path.relative(projectRoot, filePath));
  if (/(^|\/)(components|__tests__)\//.test(relative)) return null;

  const underPages = /(?:^|\/)(pages|views)\//.test(relative);
  const appPage = relative.match(/(?:^|\/)app\/(?:(.*)\/)?page\.(tsx|jsx)$/);
  if (appPage && !underPages) {
    if (relative.includes('/api/') || relative.includes('/@')) return null;
    const raw = (appPage[1] ?? '').replace(/\/$/, '');
    const segments = raw.split('/').filter(Boolean);
    if (segments.some((seg) => seg.startsWith('[...') || seg.startsWith('[[...'))) return null;
    const body = segments
      .filter((seg) => !/^\(.*\)$/.test(seg))
      .map((seg) => {
        const dynamic = seg.match(/^\[(.+)\]$/);
        return dynamic ? `:${dynamic[1]}` : seg;
      })
      .join('/');
    return body ? `/${body}` : '/';
  }

  if (!underPages) return null;
  const body = relative
    .replace(/^.*?\/(pages|views)\//, '')
    .replace(/\.(tsx|jsx|ts|js|vue)$/, '')
    .replace(/\/index$/, '')
    .replace(/^index$/, '');
  return `/${body}`;
}

export function segmentsMatch(pattern: string, concrete: string): boolean {
  const a = pattern.split('/').filter(Boolean);
  const b = concrete.split('/').filter(Boolean);
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg.startsWith(':') || seg.toLowerCase() === b[i].toLowerCase());
}

export function extractDynamicParams(routePattern: string): string[] {
  const segments = routePattern.split('/').filter(Boolean);
  const params: string[] = [];
  for (const seg of segments) {
    if (seg.startsWith(':')) {
      params.push(seg.slice(1));
    }
  }
  return params;
}
