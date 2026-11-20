import path from 'node:path';
import { createRequire } from 'node:module';

/** Resolve the browser runtime from the selected host, preferring Midscene's peer version. */
export function resolvePlaywrightRuntime(projectRoot: string): typeof import('playwright') {
  const hostRequire = createRequire(path.join(path.resolve(projectRoot), 'package.json'));
  try {
    const midsceneEntry = hostRequire.resolve('@midscene/web/playwright');
    const midsceneRequire = createRequire(midsceneEntry);
    return midsceneRequire('playwright') as typeof import('playwright');
  } catch {
    return hostRequire('playwright') as typeof import('playwright');
  }
}
