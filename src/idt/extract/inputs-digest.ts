import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Project } from 'ts-morph';
import type { IdtConfig } from '../schemas/config.schema.js';
import { toPosixPath } from '../utils/path.js';

/**
 * 拓扑的输入文件摘要。只做 glob + 读字节 + 哈希，不解析任何文件内容。
 * 覆盖 pageGlobs / routerGlobs / localeFiles 命中的全部文件。
 *
 * 用 ts-morph 的 FileSystemHost.globSync 而不是 node 的 fs.globSync，两个原因：
 *  - fs.globSync 是 Node 22 才有的，而引擎作为 submodule 跑在宿主里，
 *    活动项目宿主声明的是 engines.node >= 18，CI 也还在 Node 20；
 *  - topology.ts 本来就用 ts-morph 展开同一批 glob，共用一个引擎才能保证
 *    摘要覆盖的文件集合与拓扑实际读的那批**完全一致**，不会一边算一边漏。
 * 这里只用它的文件系统层，不建 SourceFile、不走解析，实测单项目 ~50ms。
 */
export function computeInputsDigest(
  projectRoot: string,
  config: Pick<IdtConfig, 'pageGlobs' | 'routerGlobs' | 'localeFiles'>,
): string {
  const root = path.resolve(projectRoot);
  const patterns = [...config.pageGlobs, ...config.routerGlobs, ...config.localeFiles]
    .map((pattern) => `${toPosixPath(root)}/${toPosixPath(pattern).replace(/^\.\//, '')}`);
  const relPaths = new Set<string>();

  if (patterns.length > 0) {
    const host = new Project({ skipAddingFilesFromTsConfig: true }).getFileSystem();
    let matches: string[] = [];
    try {
      matches = host.globSync(patterns);
    } catch {
      matches = [];
    }
    for (const match of matches) {
      const rel = toPosixPath(path.relative(root, match));
      if (!rel || rel.startsWith('..')) continue;
      relPaths.add(rel);
    }
  }

  // 排序必须与语言环境无关：localeCompare 的结果跟机器的 locale 走，
  // 非 ASCII 路径在不同机器上可能排出不同顺序，摘要就不稳定了。
  const sorted = [...relPaths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const hexes: string[] = [];
  for (const relPosix of sorted) {
    const abs = path.resolve(root, ...relPosix.split('/'));
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(abs);
    } catch {
      continue;
    }
    const hash = crypto.createHash('sha256');
    hash.update(Buffer.from(relPosix, 'utf8'));
    hash.update(Buffer.from([0]));
    hash.update(bytes);
    hexes.push(hash.digest('hex'));
  }

  return crypto
    .createHash('sha256')
    .update(hexes.join('\n'), 'utf8')
    .digest('hex');
}
