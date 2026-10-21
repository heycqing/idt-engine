import fs from 'node:fs';
import path from 'node:path';
import { Node, Project, SyntaxKind, type Expression, type SourceFile } from 'ts-morph';
import { toPosixPath } from '../utils/path.js';

export interface VueRouterMappingResult {
  routesByComponent: Map<string, string[]>;
  preferredComponentByRoute: Map<string, string>;
  routeRecordCount: number;
  mappedRouteCount: number;
  unresolvedComponents: string[];
  /** 静态解析出的路由模式。认不出来就是 undefined，由调用方决定回落。 */
  routerMode?: 'hash' | 'history';
  /** 只认字符串字面量的 base。表达式不猜。 */
  routerBase?: string;
}

export function extractVueRouterMappings(
  projectRoot: string,
  routerGlobs: string[],
): VueRouterMappingResult {
  const result: VueRouterMappingResult = {
    routesByComponent: new Map(),
    preferredComponentByRoute: new Map(),
    routeRecordCount: 0,
    mappedRouteCount: 0,
    unresolvedComponents: [],
  };
  if (routerGlobs.length === 0) return result;

  const modeSightings: Array<{ mode: 'hash' | 'history'; where: string }> = [];

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true },
  });
  const root = toPosixPath(path.resolve(projectRoot));
  const sourceFiles: SourceFile[] = [];
  const seenFiles = new Set<string>();
  for (const glob of routerGlobs) {
    const pattern = `${root}/${toPosixPath(glob).replace(/^\.\//, '')}`;
    const added = project.addSourceFilesAtPaths(pattern)
      .sort((a, b) => a.getFilePath().localeCompare(b.getFilePath()));
    for (const sourceFile of added) {
      if (seenFiles.has(sourceFile.getFilePath())) continue;
      seenFiles.add(sourceFile.getFilePath());
      sourceFiles.push(sourceFile);
    }
  }

  const unresolved = new Set<string>();
  for (const sourceFile of sourceFiles) {
    detectRouterMode(sourceFile, modeSightings, result);

    for (const object of sourceFile.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
      const ownPath = readStringProperty(object, 'path');
      const component = readPropertyExpression(object, 'component');
      if (ownPath == null || component == null) continue;
      result.routeRecordCount += 1;

      const componentPath = resolveComponentExpression(
        project,
        projectRoot,
        sourceFile,
        component,
        new Set(),
      );
      if (!componentPath) {
        unresolved.add(component.getText());
        continue;
      }
      const routePath = fullRoutePath(object, ownPath);
      addRoute(result.routesByComponent, componentPath, routePath);
      if (!result.preferredComponentByRoute.has(routePath)) {
        result.preferredComponentByRoute.set(routePath, componentPath);
      }
      result.mappedRouteCount += 1;
    }
  }

  for (const routes of result.routesByComponent.values()) routes.sort();
  result.unresolvedComponents = [...unresolved].sort();

  if (modeSightings.length > 0) {
    result.routerMode = modeSightings[0].mode;
    const conflicting = modeSightings.filter((s) => s.mode !== modeSightings[0].mode);
    if (conflicting.length > 0) {
      console.log(
        `[IDT] Warning: conflicting router mode. Keeping ${modeSightings[0].mode} from `
          + `${modeSightings[0].where}, ignoring ${conflicting.map((s) => `${s.mode} in ${s.where}`).join(', ')}`,
      );
    }
  }

  return result;
}

/**
 * 认 new VueRouter({ mode }) 和 createRouter({ history: createWebHashHistory() })。
 * mode 写成变量或三元就不猜，base 只认字符串字面量。
 * 注释掉的 router 不会被解析成节点，所以天然不参与判断。
 */
function detectRouterMode(
  sourceFile: SourceFile,
  sightings: Array<{ mode: 'hash' | 'history'; where: string }>,
  result: VueRouterMappingResult,
): void {
  const where = path.basename(sourceFile.getFilePath());

  for (const object of sourceFile.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
    const mode = readStringProperty(object, 'mode');
    const historyExpr = readPropertyExpression(object, 'history');

    let found: 'hash' | 'history' | null = null;
    if (mode === 'hash' || mode === 'history') {
      found = mode;
    } else if (historyExpr) {
      const text = historyExpr.getText();
      if (text.includes('createWebHashHistory')) found = 'hash';
      else if (text.includes('createWebHistory')) found = 'history';
    }
    if (!found) continue;

    sightings.push({ mode: found, where });
    if (result.routerBase === undefined) {
      const base = readStringProperty(object, 'base');
      if (base) result.routerBase = base;
    }
  }
}

function fullRoutePath(object: Node, ownPath: string): string {
  for (const ancestor of object.getAncestors()) {
    if (!Node.isObjectLiteralExpression(ancestor)) continue;
    const parentPath = readStringProperty(ancestor, 'path');
    const children = readPropertyExpression(ancestor, 'children');
    if (parentPath == null || !children || !Node.isArrayLiteralExpression(children)) continue;
    if (!object.getAncestors().includes(children)) continue;
    return joinRoutePath(fullRoutePath(ancestor, parentPath), ownPath);
  }
  return joinRoutePath('', ownPath);
}

function joinRoutePath(parent: string, child: string): string {
  if (child.startsWith('/')) return normalizeRoutePath(child);
  return normalizeRoutePath(`${parent}/${child}`);
}

function normalizeRoutePath(routePath: string): string {
  const normalized = routePath.replace(/\/{2,}/g, '/');
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function readStringProperty(object: Node, name: string): string | null {
  if (!Node.isObjectLiteralExpression(object)) return null;
  const property = object.getProperty(name);
  if (!property || !Node.isPropertyAssignment(property)) return null;
  const value = property.getInitializer();
  if (!value || (!Node.isStringLiteral(value) && !Node.isNoSubstitutionTemplateLiteral(value))) return null;
  return value.getLiteralValue();
}

function readPropertyExpression(object: Node, name: string): Expression | null {
  if (!Node.isObjectLiteralExpression(object)) return null;
  const property = object.getProperty(name);
  if (!property || !Node.isPropertyAssignment(property)) return null;
  return property.getInitializer() ?? null;
}

function resolveComponentExpression(
  project: Project,
  projectRoot: string,
  sourceFile: SourceFile,
  expression: Expression,
  seen: Set<string>,
): string | null {
  const key = `${sourceFile.getFilePath()}::${expression.getText()}`;
  if (seen.has(key)) return null;
  seen.add(key);

  if (Node.isIdentifier(expression)) {
    const name = expression.getText();
    const declaration = sourceFile.getVariableDeclaration(name);
    const initializer = declaration?.getInitializer();
    if (initializer) {
      return resolveComponentExpression(project, projectRoot, sourceFile, initializer, seen);
    }

    const imported = resolveImportedBinding(project, projectRoot, sourceFile, name);
    if (!imported) return null;
    if (imported.expression) {
      return resolveComponentExpression(
        project,
        projectRoot,
        imported.sourceFile,
        imported.expression,
        seen,
      );
    }
    return imported.filePath;
  }

  const importPath = findDynamicImport(expression);
  return importPath ? resolveComponentPath(projectRoot, sourceFile.getFilePath(), importPath) : null;
}

function resolveImportedBinding(
  project: Project,
  projectRoot: string,
  sourceFile: SourceFile,
  localName: string,
): { sourceFile: SourceFile; expression: Expression | null; filePath: string } | null {
  for (const declaration of sourceFile.getImportDeclarations()) {
    const defaultImport = declaration.getDefaultImport();
    const namedImport = declaration.getNamedImports().find(
      (item) => (item.getAliasNode()?.getText() ?? item.getName()) === localName,
    );
    if (defaultImport?.getText() !== localName && !namedImport) continue;

    const filePath = resolveComponentPath(
      projectRoot,
      sourceFile.getFilePath(),
      declaration.getModuleSpecifierValue(),
    );
    if (!filePath) return null;
    const importedSource = project.getSourceFile(filePath);
    if (!namedImport || !importedSource) {
      return { sourceFile, expression: null, filePath };
    }
    const importedDeclaration = importedSource.getVariableDeclaration(namedImport.getName());
    return {
      sourceFile: importedSource,
      expression: importedDeclaration?.getInitializer() ?? null,
      filePath,
    };
  }
  return null;
}

function findDynamicImport(node: Node): string | null {
  const calls = Node.isCallExpression(node)
    ? [node, ...node.getDescendantsOfKind(SyntaxKind.CallExpression)]
    : node.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of calls) {
    if (call.getExpression().getKind() !== SyntaxKind.ImportKeyword) continue;
    const argument = call.getArguments()[0];
    if (argument && (Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument))) {
      return argument.getLiteralValue();
    }
  }
  return null;
}

function resolveComponentPath(projectRoot: string, sourceFilePath: string, importPath: string): string | null {
  const base = importPath.startsWith('@/')
    ? path.resolve(findNearestSrc(projectRoot, sourceFilePath), importPath.slice(2))
    : importPath.startsWith('.')
      ? path.resolve(path.dirname(sourceFilePath), importPath)
      : null;
  if (!base) return null;

  const candidates = [
    base,
    `${base}.vue`,
    `${base}.js`,
    `${base}.ts`,
    path.join(base, 'index.vue'),
    path.join(base, 'index.js'),
    path.join(base, 'index.ts'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null;
}

function findNearestSrc(projectRoot: string, sourceFilePath: string): string {
  const root = path.resolve(projectRoot);
  let current = path.dirname(path.resolve(sourceFilePath));
  while (current.startsWith(root)) {
    if (path.basename(current).toLowerCase() === 'src') return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.join(root, 'src');
}

function addRoute(routesByComponent: Map<string, string[]>, componentPath: string, routePath: string): void {
  const routes = routesByComponent.get(componentPath) ?? [];
  if (!routes.includes(routePath)) routes.push(routePath);
  routesByComponent.set(componentPath, routes);
}
