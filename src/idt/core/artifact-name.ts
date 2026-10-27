import type { StateTransitionIR } from './ir-schema.js';

/** 由 IR 算出产物文件名的 stem。只依赖 IR 本身，不扫目录。 */
export function artifactStem(
  ir: Pick<StateTransitionIR, 'initialRoute' | 'flowId'>,
): string {
  const slug = ir.initialRoute
    .replace(/^\/+|\/+$/g, '')
    .replace(/\//g, '-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '') || 'root';

  return `${slug}__${ir.flowId}`;
}
