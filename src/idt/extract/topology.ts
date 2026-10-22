import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Project, Node, SyntaxKind, type SourceFile } from 'ts-morph';
import { loadIdtConfig } from '../config/load.js';
import type { IdtConfig } from '../schemas/config.schema.js';
import {
  toPosixPath,
  toRoutePattern,
  segmentsMatch,
  extractDynamicParams,
} from '../utils/path.js';
import {
  ProjectTopologySchema,
  SemanticIndexSchema,
  type ProjectTopology,
  type PageElement,
  type RouteTopologyNode,
  type RouteTransition,
  type SemanticIndex,
  type SemanticIndexEntry,
} from '../schemas/topology.schema.js';
import {
  extractVueSfc,
  listVueFiles,
  scanVueTemplate,
  stripVueFromGlob,
  type VueTemplateScan,
} from './vue-sfc.js';
import { extractVueRouterMappings } from './vue-router.js';
import {
  collectComponentElements,
  collectComponentTransitions,
} from './component-nav.js';

function isFunctionNode(node: Node): boolean {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node) ||
    Node.isMethodDeclaration(node)
  );
}

function getFunctionDeclarationText(fn: Node): string {
  const parent = fn.getParent();
  if (parent && Node.isVariableDeclaration(parent)) {
    const varDeclList = parent.getParent();
    if (varDeclList && Node.isVariableDeclarationList(varDeclList)) {
      const varStatement = varDeclList.getParent();
      if (varStatement && Node.isVariableStatement(varStatement)) {
        return varStatement.getText();
      }
    }
    return parent.getText();
  }
  return fn.getText();
}

function getJsxStaticText(element: Node): string | undefined {
  const texts: string[] = [];
  element.forEachDescendant((child) => {
    if (Node.isJsxText(child)) {
      const t = child.getText().trim();
      if (t) texts.push(t);
    } else if (Node.isStringLiteral(child)) {
      const parent = child.getParent();
      if (parent && Node.isJsxExpression(parent)) {
        const t = child.getLiteralValue().trim();
        if (t) texts.push(t);
      }
    }
  });
  const joined = texts.join(' ').trim();
  return joined.length > 0 ? joined : undefined;
}

function extractTargetRoute(node: Node): string | null {
  if (Node.isStringLiteral(node)) {
    return node.getLiteralValue();
  }
  if (Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralValue();
  }
  if (Node.isTemplateExpression(node)) {
    let result = node.getHead().getLiteralText();
    for (const span of node.getTemplateSpans()) {
      result += ':param' + span.getLiteral().getLiteralText();
    }
    return result;
  }
  if (Node.isJsxExpression(node)) {
    const expr = node.getExpression();
    if (expr) {
      return extractTargetRoute(expr);
    }
  }
  if (Node.isObjectLiteralExpression(node)) {
    const pathProp = node.getProperty('path');
    if (!pathProp || !Node.isPropertyAssignment(pathProp)) return null;
    const init = pathProp.getInitializer();
    if (!init) return null;
    if (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init)) {
      return init.getLiteralValue();
    }
    return null;
  }
  return null;
}

function hasRequest(text: string): boolean {
  return text.includes('fetch(') || text.includes('axios.') || text.includes('.request(');
}

function truncateCodeSlice(sliceText: string): string {
  const normalized = sliceText.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 200) {
    const truncated = lines.slice(0, 199);
    truncated.push('/* idt-truncated */');
    return truncated.join('\n');
  }
  return normalized;
}

function loadVuePages(project: Project, projectRoot: string, globs: string[]) {
  const pages: Array<{
    sf: SourceFile;
    absPath: string;
    relPosix: string;
    vue: VueTemplateScan;
  }> = [];
  for (const relPosix of listVueFiles(projectRoot, globs)) {
    const absPath = path.resolve(projectRoot, ...relPosix.split('/'));
    const raw = fs.readFileSync(absPath, 'utf8');
    const sfc = extractVueSfc(raw);
    const scan = scanVueTemplate(sfc.template);
    const virtualPath = path.resolve(projectRoot, '.idt-virtual', `${relPosix}.ts`);
    const script = sfc.script.trim() ? sfc.script : 'export {}\n';
    let sf: SourceFile;
    try {
      sf = project.createSourceFile(virtualPath, script, { overwrite: true });
    } catch {
      sf = project.createSourceFile(virtualPath, 'export {}\n', { overwrite: true });
    }
    pages.push({ sf, absPath, relPosix, vue: scan });
  }
  return pages;
}

export interface ExtractTopologyOptions {
  /** 由多项目标志解析出来的 globs。不传就回落到 projectRoot 下的 idt.config.ts。 */
  config?: IdtConfig;
  /** 写进拓扑顶层的项目名，便于单看一份产物认出它属于谁。 */
  projectName?: string;
  /** 覆盖静态检测出的路由模式与 base，静态解析盖不到的写法走这里。 */
  routerMode?: 'hash' | 'history';
  routerBase?: string;
  routerQuery?: Record<string, string>;
  /**
   * 顺页面的 import 往下几层收集子组件里的跳转。默认 1。
   * 0 表示关闭，退回只扫页面文件自身的旧行为。
   */
  componentNavDepth?: number;
}

export function extractProjectTopology(
  projectRoot: string,
  options: ExtractTopologyOptions = {},
): ProjectTopology {
  const config = options.config ?? loadIdtConfig(projectRoot);

  const project = new Project({
    compilerOptions: {
      jsx: 1, // Preserve
      allowJs: true,
    },
  });

  const posixRoot = toPosixPath(path.resolve(projectRoot));
  const patterns = config.pageGlobs.flatMap((glob) => {
    const cleanGlob = toPosixPath(glob).replace(/^\.\//, '');
    const morphGlob = stripVueFromGlob(cleanGlob);
    return morphGlob ? [`${posixRoot}/${morphGlob}`] : [];
  });
  if (patterns.length > 0) project.addSourceFilesAtPaths(patterns);

  const vuePages = loadVuePages(project, projectRoot, config.pageGlobs);
  const fileItems: Array<{
    sf: SourceFile;
    absPath: string;
    relPosix: string;
    vue: VueTemplateScan | null;
  }> = [];
  for (const sf of project.getSourceFiles()) {
    const absPath = sf.getFilePath();
    const relPosix = toPosixPath(path.relative(projectRoot, absPath));
    if (!relPosix || relPosix.startsWith('..') || relPosix.startsWith('.idt-virtual/') || relPosix.endsWith('.vue')) {
      continue;
    }
    fileItems.push({ sf, absPath, relPosix, vue: null });
  }
  fileItems.push(...vuePages);
  fileItems.sort((a, b) => a.relPosix.localeCompare(b.relPosix));
  const routerMappings = extractVueRouterMappings(projectRoot, config.routerGlobs);
  // 有路由配置、所有 record 都解析出了组件、且一个都没落空，才算完整。
  const routerFullyResolved =
    config.routerGlobs.length > 0 &&
    routerMappings.routeRecordCount > 0 &&
    routerMappings.mappedRouteCount === routerMappings.routeRecordCount &&
    routerMappings.unresolvedComponents.length === 0;

  const resolvedRouterMode = options.routerMode ?? routerMappings.routerMode;
  const resolvedRouterBase = options.routerBase ?? routerMappings.routerBase;
  if (config.routerGlobs.length > 0) {
    console.log(
      `[IDT] Vue Router: records=${routerMappings.routeRecordCount} `
      + `mapped=${routerMappings.mappedRouteCount} `
      + `unresolved=${routerMappings.unresolvedComponents.length}`,
    );
  }

  // Compute sourceDigest
  const fileHexes: string[] = [];
  for (const item of fileItems) {
    const hash = crypto.createHash('sha256');
    hash.update(Buffer.from(item.relPosix, 'utf8'));
    hash.update(Buffer.from([0])); // NUL byte
    hash.update(fs.readFileSync(item.absPath));
    fileHexes.push(hash.digest('hex'));
  }
  const routerMappingSource = routerMappings.routesByComponent.size === 0
    ? ''
    : [...routerMappings.routesByComponent.entries()]
      .map(([componentPath, mappedRoutes]) => (
        `${toPosixPath(path.relative(projectRoot, componentPath))}\0${mappedRoutes.join('\0')}`
      ))
      .sort()
      .join('\n')
      + '\n--preferred--\n'
      + [...routerMappings.preferredComponentByRoute.entries()]
        .map(([route, componentPath]) => (
          `${route}\0${toPosixPath(path.relative(projectRoot, componentPath))}`
        ))
        .sort()
        .join('\n');
  if (routerMappingSource) {
    fileHexes.push(crypto.createHash('sha256').update(routerMappingSource, 'utf8').digest('hex'));
  }

  const sourceDigest = crypto
    .createHash('sha256')
    .update(fileHexes.join('\n'), 'utf8')
    .digest('hex');

  // Load localeFiles
  const mergedLocales: Record<string, any> = {};
  for (const locRel of config.localeFiles) {
    const locAbs = path.resolve(projectRoot, locRel);
    if (!fs.existsSync(locAbs)) continue;
    try {
      const content = JSON.parse(fs.readFileSync(locAbs, 'utf8'));
      if (typeof content !== 'object' || content === null || Array.isArray(content)) continue;
      for (const [k, val] of Object.entries(content)) {
        if (typeof val === 'string') {
          mergedLocales[k] = val;
        } else if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
          if (
            typeof mergedLocales[k] !== 'object' ||
            mergedLocales[k] === null ||
            Array.isArray(mergedLocales[k])
          ) {
            mergedLocales[k] = {};
          }
          for (const [subK, subVal] of Object.entries(val)) {
            if (typeof subVal === 'string') {
              mergedLocales[k][subK] = subVal;
            }
          }
        }
      }
    } catch {
      // Skip invalid JSON
    }
  }

  function resolveI18nKey(key: string): string {
    if (typeof mergedLocales[key] === 'string') {
      return mergedLocales[key];
    }
    const parts = key.split('.');
    if (
      parts.length === 2 &&
      typeof mergedLocales[parts[0]] === 'object' &&
      mergedLocales[parts[0]] !== null
    ) {
      if (typeof mergedLocales[parts[0]][parts[1]] === 'string') {
        return mergedLocales[parts[0]][parts[1]];
      }
    }
    return `i18n:${key}`;
  }

  const routes: Record<string, RouteTopologyNode> = {};
  const semanticIndexMap = new Map<string, SemanticIndexEntry>();
  const componentNavDepth = options.componentNavDepth ?? 1;

  /** 页面自身的元素在前，子组件的在后；role 与 name 都相同的去重。 */
  function mergeElements(own: PageElement[], fromComponents: PageElement[]): PageElement[] {
    const seen = new Set<string>();
    const out: PageElement[] = [];
    for (const element of [...own, ...fromComponents]) {
      const key =
        element.name !== undefined
          ? `${element.role}|${element.name}`
          : `${element.role}| ${element.tag ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...element });
    }
    return out;
  }
  // 只排除真的会成为路由的文件。被 pageGlobs 命中但落在 components/ 下的
  // 不是页面，恰恰是要顺着 import 走进去的那些。
  const allPageFiles = new Set(
    fileItems
      .filter(
        (i) =>
          routerMappings.routesByComponent.has(path.resolve(i.absPath)) ||
          toRoutePattern(projectRoot, i.absPath) !== null,
      )
      .map((i) => path.resolve(i.absPath)),
  );

  for (const item of fileItems) {
    if (item.relPosix.split('/').some((segment) => segment.includes('[...'))) {
      console.log(`[IDT] Warning: catch-all page skipped: ${item.relPosix}`);
      continue;
    }

    const mappedRoutes = routerMappings.routesByComponent.get(path.resolve(item.absPath));
    const fileRoute = toRoutePattern(projectRoot, item.absPath);

    // 路由器把所有 record 都解析出来了，就说明这份路由表是完整的：没被它引用
    // 的文件在真实应用里根本到不了，再用文件路径兜底就是凭空造路由。而且
    // toRoutePattern 会剥掉 /views/ 之前的一切，src/credit/views/transfer 会
    // 变成 /transfer 跟真路由撞车。解析不完整时仍然兜底，否则会漏页面。
    if (!mappedRoutes?.length && routerFullyResolved) {
      console.log(
        `[IDT] Warning: page not mounted by any route, skipped: ${item.relPosix}`,
      );
      continue;
    }

    const rawRoutePatterns = mappedRoutes?.length ? mappedRoutes : fileRoute ? [fileRoute] : [];
    if (rawRoutePatterns.length === 0) {
      continue;
    }

    const routePatterns = rawRoutePatterns
      .map((route) => route.replace(/\[([^\]]+)\]/g, ':$1'))
      .filter((pattern) => {
        const preferred = routerMappings.preferredComponentByRoute.get(pattern);
        if (preferred && path.resolve(preferred) !== path.resolve(item.absPath)) {
          console.log(
            `[IDT] Warning: duplicate route ${pattern}; keeping `
            + `${toPosixPath(path.relative(projectRoot, preferred))}, skipping ${item.relPosix}`,
          );
          return false;
        }
        const existing = routes[pattern];
        if (!existing) return true;
        console.log(
          `[IDT] Warning: duplicate route ${pattern}; keeping ${existing.filePath}, `
          + `skipping ${item.relPosix}`,
        );
        return false;
      });
    if (routePatterns.length === 0) continue;
    const routePattern = routePatterns[0];
    const ext = path.extname(item.absPath);
    const title = path.basename(item.absPath, ext);

    const sf = item.sf;

    // Map referenced functions by onClick and onSubmit in JSX attributes
    const jsxAttrs = sf.getDescendantsOfKind(SyntaxKind.JsxAttribute);
    const clickReferencedFns = new Map<string, { attr: Node; jsxElement: Node }>();
    const submitReferencedFns = new Map<string, { attr: Node; jsxElement: Node }>();

    for (const attr of jsxAttrs) {
      const name = attr.getNameNode().getText();
      const init = attr.getInitializer();
      if (!init || !Node.isJsxExpression(init)) continue;
      const expr = init.getExpression();
      if (!expr || !Node.isIdentifier(expr)) continue;
      const identifierName = expr.getText();
      const openingOrSelf = attr.getParent()?.getParent();
      const jsxElement =
        openingOrSelf && Node.isJsxOpeningElement(openingOrSelf)
          ? openingOrSelf.getParent() ?? openingOrSelf
          : openingOrSelf ?? attr;

      if (name === 'onClick') {
        clickReferencedFns.set(identifierName, { attr, jsxElement });
      } else if (name === 'onSubmit') {
        submitReferencedFns.set(identifierName, { attr, jsxElement });
      }
    }

    // Collect all referenced function texts in this file
    const referencedFnTexts: string[] = [];
    const allReferencedNames = new Set([
      ...clickReferencedFns.keys(),
      ...submitReferencedFns.keys(),
    ]);

    for (const name of allReferencedNames) {
      // Look for function declaration or variable declaration with this name
      const fnDecl = sf.getFunction(name);
      if (fnDecl) {
        referencedFnTexts.push(fnDecl.getText());
        continue;
      }
      const varDecl = sf.getVariableDeclaration(name);
      if (varDecl) {
        const varStatement = varDecl.getVariableStatement();
        referencedFnTexts.push(varStatement ? varStatement.getText() : varDecl.getText());
      }
    }

    // Collect transitions
    const transitions: RouteTransition[] = [];

    // Helper to build codeSlice for a jump
    function createCodeSlice(jumpFnNode: Node | null): string {
      const candidateTexts: string[] = [];
      if (jumpFnNode) {
        candidateTexts.push(getFunctionDeclarationText(jumpFnNode));
      }
      for (const t of referencedFnTexts) {
        if (!candidateTexts.includes(t)) {
          candidateTexts.push(t);
        }
      }
      const requestFns = candidateTexts.filter(hasRequest);
      const otherFns = candidateTexts.filter((t) => !hasRequest(t));
      const ordered = [...requestFns, ...otherFns];
      return truncateCodeSlice(ordered.join('\n\n'));
    }

    // 1. Check CallExpressions
    const callExpressions = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
    for (const call of callExpressions) {
      const exprText = call.getExpression().getText();
      const isJump = /(?:^|\.)(\$router\.(?:push|replace)|navigate|router\.push|history\.push|redirect)$/.test(exprText);
      if (!isJump) continue;

      const args = call.getArguments();
      if (args.length === 0) continue;
      const targetRoute = extractTargetRoute(args[0]);
      if (!targetRoute) continue;

      // Determine trigger type and enclosing function
      let current = call.getParent();
      let enclosingFn: Node | null = null;
      let directJsxAttr: Node | null = null;

      while (current && !Node.isSourceFile(current)) {
        if (!enclosingFn && isFunctionNode(current)) {
          enclosingFn = current;
        }
        if (Node.isJsxAttribute(current)) {
          directJsxAttr = current;
          break;
        }
        current = current.getParent();
      }

      let triggerType: 'CLICK' | 'SUBMIT' | 'PROGRAMMATIC' = 'PROGRAMMATIC';
      let triggerElementText: string | undefined = undefined;

      if (directJsxAttr && Node.isJsxAttribute(directJsxAttr)) {
        const attrName = directJsxAttr.getNameNode().getText();
        const openingOrSelf = directJsxAttr.getParent()?.getParent();
        const jsxElement =
          openingOrSelf && Node.isJsxOpeningElement(openingOrSelf)
            ? openingOrSelf.getParent() ?? openingOrSelf
            : openingOrSelf ?? directJsxAttr;

        if (attrName === 'onSubmit') {
          triggerType = 'SUBMIT';
          triggerElementText = getJsxStaticText(jsxElement);
        } else if (attrName === 'onClick') {
          triggerType = 'CLICK';
          triggerElementText = getJsxStaticText(jsxElement);
        }
      } else if (enclosingFn) {
        let fnName: string | undefined;
        if (Node.isFunctionDeclaration(enclosingFn) || Node.isMethodDeclaration(enclosingFn)) {
          fnName = enclosingFn.getName();
        } else {
          const parent = enclosingFn.getParent();
          if (parent && (Node.isVariableDeclaration(parent) || Node.isPropertyAssignment(parent))) {
            fnName = parent.getName();
          }
        }

        if (fnName && submitReferencedFns.has(fnName)) {
          triggerType = 'SUBMIT';
          const { jsxElement } = submitReferencedFns.get(fnName)!;
          triggerElementText = getJsxStaticText(jsxElement);
        } else if (fnName && clickReferencedFns.has(fnName)) {
          triggerType = 'CLICK';
          const { jsxElement } = clickReferencedFns.get(fnName)!;
          triggerElementText = getJsxStaticText(jsxElement);
        } else if (fnName && item.vue?.clicks.has(fnName)) {
          triggerType = 'CLICK';
          triggerElementText = item.vue.clicks.get(fnName);
        }
      }

      const codeSlice = createCodeSlice(enclosingFn);
      transitions.push({
        targetRoute,
        triggerType,
        triggerElementText,
        codeSlice,
      });
    }

    // 2. Check Link and NavLink elements
    const jsxElements = [
      ...sf.getDescendantsOfKind(SyntaxKind.JsxElement),
      ...sf.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
    ];

    for (const elem of jsxElements) {
      let tagName = '';
      let attrList: Node[] = [];

      if (Node.isJsxElement(elem)) {
        tagName = elem.getOpeningElement().getTagNameNode().getText();
        attrList = elem.getOpeningElement().getAttributes();
      } else if (Node.isJsxSelfClosingElement(elem)) {
        tagName = elem.getTagNameNode().getText();
        attrList = elem.getAttributes();
      }

      if (tagName !== 'Link' && tagName !== 'NavLink') continue;

      for (const attr of attrList) {
        if (!Node.isJsxAttribute(attr)) continue;
        const attrName = attr.getNameNode().getText();
        if (attrName !== 'to' && attrName !== 'href') continue;
        const init = attr.getInitializer();
        if (!init) continue;
        const targetRoute = extractTargetRoute(init);
        if (!targetRoute) continue;

        const triggerType = 'CLICK';
        const triggerElementText = getJsxStaticText(elem);
        const codeSlice = createCodeSlice(null);

        transitions.push({
          targetRoute,
          triggerType,
          triggerElementText,
          codeSlice,
        });
      }
    }

    if (item.vue) {
      for (const link of item.vue.links) {
        transitions.push({
          targetRoute: link.targetRoute,
          triggerType: 'CLICK',
          triggerElementText: link.text,
          codeSlice: createCodeSlice(null),
        });
      }
    }

    // 页面的跳转大多写在子组件里。顺 import 往下收集，已有的目标不重复加。
    if (componentNavDepth > 0) {
      const already = new Set(transitions.map((t) => t.targetRoute));
      for (const extra of collectComponentTransitions(
        projectRoot,
        item.absPath,
        allPageFiles,
        componentNavDepth,
      )) {
        if (already.has(extra.targetRoute)) continue;
        already.add(extra.targetRoute);
        transitions.push(extra);
      }
    }

    // Collect keywords
    const routeKeywords: string[] = [];

    if (item.vue) {
      for (const text of item.vue.texts) {
        routeKeywords.push(text);
        const key = `${routePattern}:::${text}`;
        if (!semanticIndexMap.has(key)) {
          semanticIndexMap.set(key, { keyword: text, route: routePattern, kind: 'text' });
        }
      }
      for (const i18nKey of item.vue.i18nKeys) {
        const resolved = resolveI18nKey(i18nKey).trim();
        if (resolved.length >= 2) {
          routeKeywords.push(resolved);
          const entryKey = `${routePattern}:::${resolved}`;
          if (!semanticIndexMap.has(entryKey)) {
            semanticIndexMap.set(entryKey, { keyword: resolved, route: routePattern, kind: 'i18n' });
          }
        }
      }
    }

    // a. JSX text
    const jsxTexts = sf.getDescendantsOfKind(SyntaxKind.JsxText);
    for (const jt of jsxTexts) {
      const text = jt.getText().trim();
      if (text.length >= 2) {
        routeKeywords.push(text);
        const key = `${routePattern}:::${text}`;
        if (!semanticIndexMap.has(key)) {
          semanticIndexMap.set(key, { keyword: text, route: routePattern, kind: 'text' });
        }
      }
    }

    // b. JSX attribute string literals
    for (const attr of jsxAttrs) {
      const init = attr.getInitializer();
      if (!init) continue;
      let text: string | null = null;
      if (Node.isStringLiteral(init)) {
        text = init.getLiteralValue().trim();
      } else if (Node.isJsxExpression(init)) {
        const expr = init.getExpression();
        if (expr && Node.isStringLiteral(expr)) {
          text = expr.getLiteralValue().trim();
        }
      }
      if (text && text.length >= 2) {
        routeKeywords.push(text);
        const key = `${routePattern}:::${text}`;
        if (!semanticIndexMap.has(key)) {
          semanticIndexMap.set(key, { keyword: text, route: routePattern, kind: 'text' });
        }
      }
    }

    // c. i18n calls: t('key') or formatMessage({ id: 'key' })
    for (const call of callExpressions) {
      const exprText = call.getExpression().getText();
      if (exprText === 't' || exprText.endsWith('.t') || exprText === '$t' || exprText.endsWith('.$t')) {
        const args = call.getArguments();
        if (args.length > 0 && Node.isStringLiteral(args[0])) {
          const key = args[0].getLiteralValue();
          const resolved = resolveI18nKey(key);
          const trimmed = resolved.trim();
          if (trimmed.length >= 2) {
            routeKeywords.push(trimmed);
            const entryKey = `${routePattern}:::${trimmed}`;
            if (!semanticIndexMap.has(entryKey)) {
              semanticIndexMap.set(entryKey, {
                keyword: trimmed,
                route: routePattern,
                kind: 'i18n',
              });
            }
          }
        }
      } else if (exprText === 'formatMessage' || exprText.endsWith('.formatMessage')) {
        const args = call.getArguments();
        if (args.length > 0 && Node.isObjectLiteralExpression(args[0])) {
          const idProp = args[0].getProperty('id');
          if (idProp && Node.isPropertyAssignment(idProp)) {
            const init = idProp.getInitializer();
            if (init && Node.isStringLiteral(init)) {
              const key = init.getLiteralValue();
              const resolved = resolveI18nKey(key);
              const trimmed = resolved.trim();
              if (trimmed.length >= 2) {
                routeKeywords.push(trimmed);
                const entryKey = `${routePattern}:::${trimmed}`;
                if (!semanticIndexMap.has(entryKey)) {
                  semanticIndexMap.set(entryKey, {
                    keyword: trimmed,
                    route: routePattern,
                    kind: 'i18n',
                  });
                }
              }
            }
          }
        }
      }
    }

    // d. Title
    if (title.trim().length >= 2) {
      const titleKeyword = title.trim();
      routeKeywords.push(titleKeyword);
      const titleEntryKey = `${routePattern}:::${titleKeyword}`;
      if (!semanticIndexMap.has(titleEntryKey)) {
        semanticIndexMap.set(titleEntryKey, {
          keyword: titleKeyword,
          route: routePattern,
          kind: 'title',
        });
      }
    }

    const primarySemanticEntries = [...semanticIndexMap.values()].filter(
      (entry) => entry.route === routePattern,
    );
    for (const pattern of routePatterns) {
      if (pattern !== routePattern) {
        for (const entry of primarySemanticEntries) {
          const key = `${pattern}:::${entry.keyword}`;
          if (!semanticIndexMap.has(key)) {
            semanticIndexMap.set(key, { ...entry, route: pattern });
          }
        }
      }
      routes[pattern] = {
        path: pattern,
        filePath: item.relPosix,
        title,
        semanticKeywords: Array.from(new Set(routeKeywords)),
        dynamicParams: extractDynamicParams(pattern),
        transitions: transitions.map((transition) => ({ ...transition })),
        elements: mergeElements(
          item.vue?.elements ?? [],
          componentNavDepth > 0
            ? collectComponentElements(
                projectRoot,
                item.absPath,
                allPageFiles,
                componentNavDepth,
              )
            : [],
        ),
      };
    }
  }

  // Second pass: Route normalization for transitions
  const patternRoutes = Object.keys(routes);
  for (const node of Object.values(routes)) {
    for (const transition of node.transitions) {
      const concrete = transition.targetRoute;
      const matching = patternRoutes.filter((pat) => segmentsMatch(pat, concrete));
      if (matching.length === 1) {
        transition.targetRoute = matching[0];
      }
    }
  }

  const generatedAt = new Date().toISOString();

  const topology: ProjectTopology = {
    version: '1.0.0',
    generatedAt,
    sourceDigest,
    ...(options.projectName ? { project: options.projectName } : {}),
    ...(resolvedRouterMode
      ? {
          router: {
            mode: resolvedRouterMode,
            ...(resolvedRouterBase ? { base: resolvedRouterBase } : {}),
            ...(options.routerQuery && Object.keys(options.routerQuery).length > 0
              ? { query: options.routerQuery }
              : {}),
          },
        }
      : {}),
    routes,
  };

  const semanticIndex: SemanticIndex = {
    version: '1.0.0',
    sourceDigest,
    entries: Array.from(semanticIndexMap.values()),
  };

  // Validate schemas
  ProjectTopologySchema.parse(topology);
  SemanticIndexSchema.parse(semanticIndex);

  // Write files atomically using .tmp files
  const idtDir = path.resolve(projectRoot, '.idt');
  fs.mkdirSync(idtDir, { recursive: true });

  const topoPath = path.join(idtDir, 'topology.json');
  const topoTmp = path.join(idtDir, 'topology.json.tmp');
  fs.writeFileSync(topoTmp, JSON.stringify(topology, null, 2), 'utf8');
  fs.renameSync(topoTmp, topoPath);

  const semPath = path.join(idtDir, 'semantic-index.json');
  const semTmp = path.join(idtDir, 'semantic-index.json.tmp');
  fs.writeFileSync(semTmp, JSON.stringify(semanticIndex, null, 2), 'utf8');
  fs.renameSync(semTmp, semPath);

  return topology;
}

export function readTopology(projectRoot: string): ProjectTopology {
  const topologyPath = path.resolve(projectRoot, '.idt/topology.json');
  if (fs.existsSync(topologyPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(topologyPath, 'utf8'));
      const parsed = ProjectTopologySchema.safeParse(raw);
      if (parsed.success) {
        return parsed.data;
      }
    } catch {
      // Re-extract if reading or JSON parsing fails
    }
  }

  // First extraction attempt
  extractProjectTopology(projectRoot);

  if (fs.existsSync(topologyPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(topologyPath, 'utf8'));
      const parsed = ProjectTopologySchema.safeParse(raw);
      if (parsed.success) {
        return parsed.data;
      }
    } catch {
      // Failed again
    }
  }

  const error = new Error('Topology validation failed after re-extraction');
  (error as any).exitCode = 1;
  throw error;
}

export function readSemanticIndex(projectRoot: string): SemanticIndex {
  const semPath = path.resolve(projectRoot, '.idt/semantic-index.json');
  if (!fs.existsSync(semPath)) {
    const error = new Error(`Semantic index file not found at ${semPath}. Please run idt:sync first.`);
    (error as any).exitCode = 2;
    throw error;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(semPath, 'utf8'));
    const parsed = SemanticIndexSchema.safeParse(raw);
    if (!parsed.success) {
      const error = new Error(`Semantic index validation failed: ${parsed.error.message}`);
      (error as any).exitCode = 2;
      throw error;
    }
    return parsed.data;
  } catch (err: any) {
    if (err.exitCode === 2) throw err;
    const error = new Error(`Failed to parse semantic index: ${err.message}`);
    (error as any).exitCode = 2;
    throw error;
  }
}
