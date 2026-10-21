import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Project, Node, SyntaxKind, type SourceFile } from 'ts-morph';
import { loadIdtConfig } from '../config/load.js';
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

export function extractProjectTopology(projectRoot: string): ProjectTopology {
  const config = loadIdtConfig(projectRoot);

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

  for (const item of fileItems) {
    if (item.relPosix.split('/').some((segment) => segment.includes('[...'))) {
      console.log(`[IDT] Warning: catch-all page skipped: ${item.relPosix}`);
      continue;
    }

    const mappedRoutes = routerMappings.routesByComponent.get(path.resolve(item.absPath));
    const fileRoute = toRoutePattern(projectRoot, item.absPath);
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
