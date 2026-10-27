import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE_REPO = 'https://github.com/heycqing/idt-engine.git';
const SUBMODULE_DIR = 'idt-engine';

const PAGE_GLOBS = [
  ['src/pages', 'src/pages/**/*.{tsx,jsx,ts,js,vue}'],
  ['src/app', 'src/app/**/page.{tsx,jsx}'],
  ['src/views', 'src/views/**/*.{tsx,jsx,ts,js,vue}'],
  ['pages', 'pages/**/*.{tsx,jsx,ts,js,vue}'],
  ['app', 'app/**/page.{tsx,jsx}'],
];

const ROUTER_GLOBS = [
  ['src/router', 'src/router/**/*.{js,ts}'],
  ['src/credit/router', 'src/credit/router/**/*.{js,ts}'],
];

const LOCALE_CANDIDATES = ['src/locales/zh-CN.json', 'locales/zh-CN.json'];

const E2E_COMMAND = 'playwright test --config=.idt/playwright.config.ts';
const ENV_FILE = '.env.idt.local';
const ENV_EXAMPLE_FILE = '.env.idt.example';

const GITIGNORE_LINES = [
  ENV_FILE,
  '.idt/',
  'test-results/',
  'playwright-report/',
  'blob-report/',
];

const ENGINE_DEV_DEPS = [
  '@playwright/test',
  '@types/node',
  'commander',
  'cross-spawn',
  'ts-morph',
  'tsx',
  'typescript',
  'zod',
];

export function engineRootFromScript() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
}

export function toPosixRelative(fromDir, toDir) {
  const nativeRel = path.relative(fromDir, toDir);
  const rel = nativeRel.split(path.sep).join('/');
  if (rel === '') return '.';
  if (path.isAbsolute(nativeRel)) return rel;
  return rel.startsWith('.') ? rel : `./${rel}`;
}

export function detectPageGlobs(hostRoot) {
  const found = [];
  const seen = new Set();

  function add(dirRel, glob) {
    if (seen.has(glob)) return;
    if (fs.existsSync(path.join(hostRoot, dirRel))) {
      seen.add(glob);
      found.push(glob);
    }
  }

  for (const [dirRel, glob] of PAGE_GLOBS) add(dirRel, glob);

  for (const parent of ['apps', 'packages']) {
    const parentAbs = path.join(hostRoot, parent);
    if (!fs.existsSync(parentAbs)) continue;
    for (const entry of fs.readdirSync(parentAbs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const [dirRel, glob] of PAGE_GLOBS) {
        const nestedDir = `${parent}/${entry.name}/${dirRel}`;
        const nestedGlob = `${parent}/${entry.name}/${glob}`;
        add(nestedDir, nestedGlob);
      }
    }
  }

  if (found.length > 0) return { pageGlobs: found, usedDefaults: false };

  return {
    pageGlobs: PAGE_GLOBS.slice(0, 3).map(([, glob]) => glob),
    usedDefaults: true,
  };
}

export function detectLocaleFiles(hostRoot) {
  return LOCALE_CANDIDATES.filter((rel) => fs.existsSync(path.join(hostRoot, rel)));
}

export function detectRouterGlobs(hostRoot) {
  const found = [];
  const add = (dirRel, glob) => {
    if (fs.existsSync(path.join(hostRoot, dirRel)) && !found.includes(glob)) found.push(glob);
  };

  for (const [dirRel, glob] of ROUTER_GLOBS) add(dirRel, glob);
  for (const parent of ['apps', 'packages']) {
    const parentAbs = path.join(hostRoot, parent);
    if (!fs.existsSync(parentAbs)) continue;
    for (const entry of fs.readdirSync(parentAbs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const [dirRel, glob] of ROUTER_GLOBS) {
        add(`${parent}/${entry.name}/${dirRel}`, `${parent}/${entry.name}/${glob}`);
      }
    }
  }
  return found.sort();
}

export function renderIdtConfig(pageGlobs, localeFiles, routerGlobs = []) {
  return `export default {\n  pageGlobs: ${JSON.stringify(pageGlobs, null, 2).replace(/\n/g, '\n  ')},\n  localeFiles: ${JSON.stringify(localeFiles)},\n  routerGlobs: ${JSON.stringify(routerGlobs, null, 2).replace(/\n/g, '\n  ')},\n};\n`;
}

export function renderEnvExample() {
  return `# IDT 项目就近配置模板。复制为 ${ENV_FILE} 后填写，${ENV_FILE} 已被 .gitignore 忽略。
# 这三项只服务 pnpm idt（gen）。sync、emit、heal 不需要。
# 留空的字段会回退到终端环境变量，再回退到引擎默认值。

# 模型密钥。不要把真实值写进这个模板文件。
OPENAI_API_KEY=

# 兼容 OpenAI 的接口地址，默认 https://api.openai.com/v1
OPENAI_BASE_URL=

# 模型名，默认 gpt-4o
IDT_MODEL_NAME=
`;
}

export function quoteCmd(posixPath) {
  return posixPath.includes(' ') ? `"${posixPath}"` : posixPath;
}

export function desiredScripts(enginePosix, tsxRuntimePosix = '') {
  const cli = quoteCmd(`${enginePosix}/scripts/idt/cli.ts`);
  const command = tsxRuntimePosix
    ? `node ${quoteCmd(tsxRuntimePosix)} ${cli}`
    : `tsx ${cli}`;
  return {
    idt: `${command} gen`,
    'idt:sync': `${command} sync`,
    'idt:emit': `${command} emit`,
    'idt:heal': `${command} heal`,
    'idt:probe': `${command} probe`,
    'idt:batch': `${command} batch`,
    'idt:verify': `${command} verify`,
    'idt:test': `${command} test`,
    'idt:projects': `${command} projects`,
  };
}

export function mergeGitignore(existing) {
  const text = existing ?? '';
  const lines = text.split(/\r?\n/);
  const present = new Set(lines.map((line) => line.trim()).filter(Boolean));
  const added = GITIGNORE_LINES.filter((line) => !present.has(line));
  if (added.length === 0) return { text, added };
  const base = text.endsWith('\n') || text.length === 0 ? text : `${text}\n`;
  return { text: `${base}${added.join('\n')}\n`, added };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const indent = raw.includes('\t') ? '\t' : 2;
  const trailing = raw.endsWith('\n') || raw.length === 0 ? '\n' : '';
  fs.writeFileSync(file, `${JSON.stringify(value, null, indent)}${trailing}`, 'utf8');
}

function hasDep(pkg, name) {
  return Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name] || pkg.optionalDependencies?.[name]);
}

function defaultRun(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    shell: process.platform === 'win32',
    encoding: 'utf8',
    stdio: 'inherit',
  });
  return result.status ?? 1;
}

/**
 * 往业务方 package.json 写 idt 标志。已有标志不动——它可能带着手工调过的
 * devCommand 和 port，覆盖掉就白调了。返回写入的项目名，没写返回 null。
 */
export function writeProjectMarker(hostRoot, projectRel, projectName) {
  const projectDir = path.resolve(hostRoot, ...projectRel.split(/[\/]/));
  const pkgPath = path.join(projectDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    throw Object.assign(new Error(`项目没有 package.json：${projectDir}`), { exitCode: 2 });
  }

  const pkg = readJson(pkgPath);
  if (pkg.idt && typeof pkg.idt === 'object' && !Array.isArray(pkg.idt)) {
    return null;
  }

  const name = (projectName ?? path.basename(projectDir)).trim();
  pkg.idt = { project: name };
  writeJson(pkgPath, pkg);
  return name;
}

/** pnpm 在 workspace 根目录执行 add 必须显式 -w，否则报 ERR_PNPM_ADDING_TO_ROOT。 */
export function isPnpmWorkspaceRoot(hostRoot) {
  return ['pnpm-workspace.yaml', 'pnpm-workspace.yml'].some((name) =>
    fs.existsSync(path.join(hostRoot, name)),
  );
}

function cliExists(dir) {
  return fs.existsSync(path.join(dir, 'scripts', 'idt', 'cli.ts'));
}

export function parseArgs(argv) {
  const opts = {
    host: '',
    engine: '',
    noInstall: false,
    noSubmodule: false,
    skipBrowsers: false,
    skipSync: false,
    project: '',
    projectName: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--host') opts.host = argv[++i] ?? '';
    else if (arg === '--engine') opts.engine = argv[++i] ?? '';
    else if (arg === '--no-install') opts.noInstall = true;
    else if (arg === '--no-submodule') opts.noSubmodule = true;
    else if (arg === '--skip-browsers') opts.skipBrowsers = true;
    else if (arg === '--skip-sync') opts.skipSync = true;
    else if (arg === '--project') opts.project = argv[++i] ?? '';
    else if (arg === '--project-name') opts.projectName = argv[++i] ?? '';
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`未知参数 ${arg}`);
  }
  return opts;
}

export function linkHost(options) {
  const log = options.log ?? console.log;
  const run = options.run ?? defaultRun;
  const engineRoot = path.resolve(options.engineRoot);
  let hostRoot = path.resolve(options.hostRoot);
  const notes = [];

  if (!fs.existsSync(path.join(hostRoot, 'package.json'))) {
    throw Object.assign(new Error(`宿主没有 package.json：${hostRoot}`), { exitCode: 2 });
  }
  if (path.resolve(hostRoot) === path.resolve(engineRoot)) {
    throw Object.assign(new Error('宿主就是引擎仓库。请传入宿主根目录，例如 pnpm idt:link -- --host D:\\宿主'), { exitCode: 2 });
  }

  const relToHost = path.relative(hostRoot, engineRoot);
  const inside = relToHost !== '' && !relToHost.startsWith('..') && !path.isAbsolute(relToHost);
  const submoduleRoot = path.join(hostRoot, SUBMODULE_DIR);
  if (!inside && !options.noSubmodule && fs.existsSync(path.join(hostRoot, '.git'))) {
    if (cliExists(submoduleRoot)) {
      log(`使用宿主里已有的 ${SUBMODULE_DIR}`);
    } else {
      log(`把 ${ENGINE_REPO} 加为子模块 ${SUBMODULE_DIR}`);
      const code = run('git', ['submodule', 'add', ENGINE_REPO, SUBMODULE_DIR], hostRoot);
      if (code !== 0 || !cliExists(submoduleRoot)) {
        notes.push('子模块没有加成功，脚本改为指向这次传入的引擎目录。换机器前需要在宿主里重新执行 git submodule add。');
      }
    }
  }

  const linkedEngine = cliExists(submoduleRoot) && !options.noSubmodule ? submoduleRoot : engineRoot;
  if (!cliExists(linkedEngine)) {
    throw Object.assign(new Error(`找不到引擎命令行：${linkedEngine}`), { exitCode: 2 });
  }

  const enginePosix = toPosixRelative(hostRoot, linkedEngine);
  const localTsx = path.join(linkedEngine, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const tsxRuntimePosix = options.noInstall && fs.existsSync(localTsx)
    ? toPosixRelative(hostRoot, localTsx)
    : '';
  const scripts = desiredScripts(enginePosix, tsxRuntimePosix);
  const pkgPath = path.join(hostRoot, 'package.json');
  const pkg = readJson(pkgPath);
  pkg.scripts ??= {};
  const scriptNotes = [];
  for (const [name, command] of Object.entries(scripts)) {
    if (pkg.scripts[name] === undefined) {
      pkg.scripts[name] = command;
      scriptNotes.push(`写入脚本 ${name}`);
    } else if (pkg.scripts[name] !== command) {
      scriptNotes.push(`保留已有脚本 ${name}`);
    }
  }
  if (pkg.scripts['test:e2e'] === undefined) {
    pkg.scripts['test:e2e'] = E2E_COMMAND;
    scriptNotes.push('写入脚本 test:e2e');
  } else if (pkg.scripts['test:e2e'] === E2E_COMMAND || pkg.scripts['test:idt:e2e'] === E2E_COMMAND) {
    scriptNotes.push('保留已有的 IDT 端到端脚本');
  } else {
    pkg.scripts['test:idt:e2e'] = E2E_COMMAND;
    scriptNotes.push('宿主已有 test:e2e，IDT 使用 test:idt:e2e');
  }
  writeJson(pkgPath, pkg);

  let markerWritten = null;
  if (options.project) {
    markerWritten = writeProjectMarker(hostRoot, options.project, options.projectName);
    notes.push(
      markerWritten
        ? `写入标志 ${options.project}/package.json -> "idt": { "project": "${markerWritten}" }`
        : `保留 ${options.project} 已有的 idt 标志`,
    );
  }

  const configPath = path.join(hostRoot, 'idt.config.ts');
  let configWritten = false;
  if (!fs.existsSync(configPath)) {
    const detected = detectPageGlobs(hostRoot);
    const locales = detectLocaleFiles(hostRoot);
    const routerGlobs = detectRouterGlobs(hostRoot);
    fs.writeFileSync(configPath, renderIdtConfig(detected.pageGlobs, locales, routerGlobs), 'utf8');
    configWritten = true;
    if (detected.usedDefaults) {
      notes.push('没有扫到页面目录，idt.config.ts 使用了默认 pageGlobs。页面若不在 src/pages、src/app、src/views，请改这份文件后再执行 pnpm idt:sync。');
    }
  } else {
    notes.push('保留已有 idt.config.ts');
  }

  // 多项目宿主的启动命令来自各项目标志的 devCommand，根目录没有 dev 脚本很正常。
  const multiProject = fs.existsSync(path.join(hostRoot, 'apps'));
  if (!pkg.scripts?.dev && !pkg.scripts?.start && !multiProject) {
    notes.push('宿主没有 dev 或 start 脚本。idt:sync 生成的 Playwright 配置会缺 webServer，--yes、test:e2e、idt:heal 在补上启动命令之前不要跑。');
  }

  const envExamplePath = path.join(hostRoot, ENV_EXAMPLE_FILE);
  let envExampleWritten = false;
  if (!fs.existsSync(envExamplePath)) {
    fs.writeFileSync(envExamplePath, renderEnvExample(), 'utf8');
    envExampleWritten = true;
  } else {
    notes.push(`保留已有 ${ENV_EXAMPLE_FILE}`);
  }

  const gitignorePath = path.join(hostRoot, '.gitignore');
  const merged = mergeGitignore(fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '');
  if (merged.added.length > 0) fs.writeFileSync(gitignorePath, merged.text, 'utf8');

  const enginePkg = readJson(path.join(engineRoot, 'package.json'));
  const missing = ENGINE_DEV_DEPS.filter((name) => !hasDep(pkg, name));
  let installCode = 0;
  if (!options.noInstall && missing.length > 0) {
    const specs = missing.map((name) => {
      const version = enginePkg.devDependencies?.[name];
      return version ? `${name}@${version}` : name;
    });
    log(`安装依赖：${specs.join(' ')}`);
    const addArgs = isPnpmWorkspaceRoot(hostRoot)
      ? ['add', '-D', '-w', ...specs]
      : ['add', '-D', ...specs];
    installCode = run('pnpm', addArgs, hostRoot);
    if (installCode !== 0) notes.push('依赖安装失败。文件已经写好，可以在宿主里重新执行 pnpm add。');
  }

  let syncCode = 0;
  if (!options.noInstall && !options.skipSync && installCode === 0) {
    log('扫描宿主页面');
    syncCode = run('pnpm', ['idt:sync'], hostRoot);
    if (syncCode !== 0) notes.push('idt:sync 失败。先看 idt.config.ts 的 pageGlobs 是否指到真实页面。');
  }

  let browserCode = 0;
  if (!options.noInstall && !options.skipBrowsers && installCode === 0) {
    log('安装 Chromium');
    browserCode = run('pnpm', ['exec', 'playwright', 'install', 'chromium'], hostRoot);
    if (browserCode !== 0) notes.push('Chromium 安装失败。生成 IR 不需要浏览器；--yes 和 idt:heal 需要。');
  }

  const outside = enginePosix.startsWith('..');
  if (outside) {
    notes.push(`命令指向宿主外面的引擎：${enginePosix}。这台机器可以直接跑。要让仓库自己带上引擎，在宿主执行 git submodule add ${ENGINE_REPO} ${SUBMODULE_DIR} 后再运行一次接入。`);
  }

  for (const line of [...scriptNotes, ...notes]) log(line);
  log(`接入完成。在宿主根目录把 ${ENV_EXAMPLE_FILE} 复制为 ${ENV_FILE} 并填写项目配置，然后执行 pnpm idt "一句意图"。先不要加 --yes。`);

  return {
    hostRoot,
    enginePosix,
    configWritten,
    markerWritten,
    envExampleWritten,
    gitignoreAdded: merged.added,
    missing,
    installCode,
    syncCode,
    browserCode,
    notes,
  };
}

function printHelp() {
  console.log(`用法：
  node scripts/idt/link-host.mjs --host <宿主根目录>
  pnpm idt:link -- --host <宿主根目录>

在宿主根目录、且已经有 ./idt-engine 时：
  node idt-engine/scripts/idt/link-host.mjs

--no-submodule  不把 GitHub 仓库加进宿主，直接指向 --engine
--no-install    只写配置和脚本，不安装依赖、不扫描页面、不下载浏览器
--skip-sync     不执行 idt:sync
--skip-browsers 不下载 Chromium
--project <相对路径>   往该业务方 package.json 写 idt 标志，例如 apps/caida
--project-name <名字>  标志里的项目名，默认取目录名`);
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    printHelp();
    process.exit(2);
  }
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  const engineRoot = path.resolve(opts.engine || engineRootFromScript());
  let hostRoot = opts.host ? path.resolve(opts.host) : process.cwd();
  if (!opts.host && cliExists(path.join(hostRoot, SUBMODULE_DIR))) {
    hostRoot = process.cwd();
  } else if (!opts.host && path.resolve(hostRoot) === engineRoot) {
    printHelp();
    process.exit(2);
  }

  try {
    const result = linkHost({
      hostRoot,
      engineRoot,
      noInstall: opts.noInstall,
      noSubmodule: opts.noSubmodule,
      skipBrowsers: opts.skipBrowsers,
      skipSync: opts.skipSync,
      project: opts.project || undefined,
      projectName: opts.projectName || undefined,
    });
    const failed = result.installCode || result.syncCode || result.browserCode;
    process.exit(failed ? 1 : 0);
  } catch (err) {
    console.error(err.message ?? err);
    process.exit(err.exitCode ?? 1);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
