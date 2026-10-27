import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { loadIdtConfig } from '../../src/idt/config/load.js';
import {
  IDT_ENV_FILE,
  loadIdtProjectEnv,
  requireModelCredentials,
} from '../../src/idt/config/project-env.js';
import {
  resolveProjects,
  selectProject,
  type IdtProject,
} from '../../src/idt/config/projects.js';
import { extractProjectTopology } from '../../src/idt/extract/topology.js';
import {
  PROJECT_PLAYWRIGHT_CONFIG,
  projectBaseUrl,
  writeProjectPlaywrightConfig,
} from '../../src/idt/core/playwright-config.js';
import { generateFlow } from '../../src/idt/core/generate.js';
import { OpenAiClient } from '../../src/idt/core/openai-client.js';
import { emitIrFile, emitSpec } from '../../src/idt/core/emitter.js';
import { heal } from '../../src/idt/core/healer.js';
import { probe } from '../../src/idt/core/prober.js';
import { playwrightCliEntry } from '../../src/idt/core/runner.js';
import { selectBatchRoutes } from '../../src/idt/core/batch-routes.js';
import { readRouterOptions } from '../../src/idt/core/route-url.js';
import {
  verifyCases,
  type VerifyCase,
  type VerifyFinding,
} from '../../src/idt/core/verify.js';
import {
  StateTransitionIRSchema,
  type StateTransitionIR,
} from '../../src/idt/core/ir-schema.js';

const program = new Command();

function fail(err: any): never {
  const exitCode = typeof err?.exitCode === 'number' ? err.exitCode : 1;
  console.error(err?.message ?? String(err));
  process.exit(exitCode);
}

/**
 * IDT 根目录由最近的 idt.config.ts 决定，配置和密钥都在那一层；
 * 项目由业务方 package.json 里的 idt 标志决定，产物跟着项目根走。
 */
function workspace() {
  const env = loadIdtProjectEnv(process.cwd());
  const config = loadIdtConfig(env.projectRoot);
  return { env, config, projects: resolveProjects(env.projectRoot, config) };
}

function pick(projects: IdtProject[], name?: string): IdtProject {
  return selectProject(projects, { name, cwd: process.cwd() });
}

function extractOptions(project: IdtProject) {
  return {
    config: {
      pageGlobs: project.pageGlobs,
      routerGlobs: project.routerGlobs,
      localeFiles: project.localeFiles,
    },
    projectName: project.implicit ? undefined : project.name,
    routerQuery: project.urlQuery,
    routerMode: project.routerMode,
    routerBase: project.routerBase,
  };
}

function syncOne(project: IdtProject): void {
  extractProjectTopology(project.root, extractOptions(project));
  writeProjectPlaywrightConfig(project);
}

program
  .command('sync')
  .description('Sync project topology and semantic index')
  .option('--project <name>', 'Only sync this project')
  .action((options: { project?: string }) => {
    try {
      const { projects } = workspace();
      const targets = options.project ? [pick(projects, options.project)] : projects;

      for (const project of targets) {
        syncOne(project);
        const label = project.implicit ? '' : `[${project.name}] `;
        console.log(
          `${label}Successfully generated .idt/topology.json, .idt/semantic-index.json and .idt/playwright.config.ts`,
        );
      }
      process.exit(0);
    } catch (err: any) {
      fail(err);
    }
  });

program
  .command('gen <intent>')
  .description('Generate State Transition IR and spec from intent')
  .option('--project <name>', 'IDT project to generate for')
  .option('--case <file>', 'Prose case file')
  .option('--force', 'Force overwrite existing IR and spec')
  .option('--yes', 'Run tests after generation')
  .action(
    async (
      intent: string,
      options: { project?: string; case?: string; force?: boolean; yes?: boolean },
    ) => {
      try {
        const { env, projects } = workspace();
        const credentials = requireModelCredentials(env);
        if (env.sourcePath) {
          console.log(
            `模型配置来自 ${path.relative(env.projectRoot, env.sourcePath) || IDT_ENV_FILE}`,
          );
        }

        const project = pick(projects, options.project);
        if (!project.implicit) console.log(`项目 ${project.name}`);

        let proseCase: string | undefined = undefined;
        if (options.case) {
          const casePath = path.resolve(process.cwd(), options.case);
          if (!fs.existsSync(casePath)) {
            console.error(`Case file not found: ${casePath}`);
            process.exit(2);
          }
          proseCase = fs.readFileSync(casePath, 'utf8');
        }

        const client = new OpenAiClient({
          apiKey: credentials.apiKey,
          baseUrl: credentials.baseUrl,
          modelName: credentials.modelName,
        });

        const result = await generateFlow({
          projectRoot: project.root,
          intent,
          proseCase,
          model: client,
          force: options.force,
          yes: options.yes,
          extract: extractOptions(project),
        });

        process.exit(result.exitCode);
      } catch (err: any) {
        fail(err);
      }
    },
  );

program
  .command('batch')
  .description('Generate one spec per route, skipping intent matching')
  .option('--project <name>', 'IDT project to generate for')
  .option('--limit <n>', 'Stop after this many routes', (v) => Number(v))
  .option('--filter <substring>', 'Only routes whose path contains this')
  .option('--exclude <substrings>', 'Skip routes containing any of these (comma separated)')
  .option('--force', 'Overwrite existing IR and spec')
  .action(async (options: {
    project?: string;
    limit?: number;
    filter?: string;
    exclude?: string;
    force?: boolean;
  }) => {
    try {
      const { env, projects } = workspace();
      const credentials = requireModelCredentials(env);
      const project = pick(projects, options.project);
      if (!project.implicit) console.log(`项目 ${project.name}`);

      const topologyPath = path.resolve(project.root, '.idt', 'topology.json');
      if (!fs.existsSync(topologyPath)) {
        console.error('还没有拓扑，先执行 idt:sync');
        process.exit(2);
      }
      const topology = JSON.parse(fs.readFileSync(topologyPath, 'utf8'));

      const routes = selectBatchRoutes(topology, {
        filter: options.filter,
        exclude: options.exclude,
        limit: options.limit,
      });

      if (routes.length === 0) {
        console.error('没有可生成的路由（需要至少一个有确定名字的元素）');
        process.exit(2);
      }

      const client = new OpenAiClient({
        apiKey: credentials.apiKey,
        baseUrl: credentials.baseUrl,
        modelName: credentials.modelName,
      });

      console.log(`准备为 ${routes.length} 条路由生成 spec`);
      console.log();
      const failures: Array<{ route: string; reason: string }> = [];
      let ok = 0;

      for (const [i, route] of routes.entries()) {
        const label = `[${i + 1}/${routes.length}] ${route}`;
        try {
          await generateFlow({
            projectRoot: project.root,
            intent: `打开 ${route} 页面并确认页面已就绪`,
            route,
            model: client,
            force: options.force,
            extract: extractOptions(project),
            log: () => {},
          });
          ok += 1;
          console.log(`${label}  ok`);
        } catch (err: any) {
          const reason = String(err?.message ?? err).split('\n')[0].slice(0, 110);
          failures.push({ route, reason });
          console.log(`${label}  跳过：${reason}`);
        }
      }

      console.log();
      console.log(`生成成功 ${ok} / ${routes.length}`);
      if (failures.length > 0) {
        console.log('未生成的路由：');
        for (const f of failures) console.log(`  ${f.route}  ${f.reason}`);
      }
      process.exit(0);
    } catch (err: any) {
      fail(err);
    }
  });

program
  .command('emit <ir>')
  .description('Emit Playwright spec from State Transition IR')
  .option('--project <name>', 'IDT project the IR belongs to')
  .action((ir: string, options: { project?: string }) => {
    try {
      const { projects } = workspace();
      const project = pick(projects, options.project);
      const result = emitIrFile(project.root, path.resolve(process.cwd(), ir));
      console.log(`Successfully emitted spec: ${result.specPath}`);
      process.exit(0);
    } catch (err: any) {
      fail(err);
    }
  });

program
  .command('verify')
  .description('Verify generated specs against current source topology')
  .option('--project <name>', 'Only verify this project')
  .option('--strict', 'Treat warnings as failures')
  .action((options: { project?: string; strict?: boolean }) => {
    try {
      const { projects } = workspace();
      const targets = options.project ? [pick(projects, options.project)] : projects;

      // 全部项目先过配置门槛，避免输出半份报告后才以配置错误退出。
      for (const project of targets) {
        const topologyPath = path.resolve(project.root, '.idt', 'topology.json');
        if (!fs.existsSync(topologyPath)) {
          const label = project.implicit ? '' : `[${project.name}] `;
          console.error(`${label}还没有拓扑，先执行 idt:sync`);
          process.exit(2);
        }
      }

      let errorCount = 0;
      let warningCount = 0;
      let caseCount = 0;

      for (const project of targets) {
        const topologyPath = path.resolve(project.root, '.idt', 'topology.json');
        const topology = JSON.parse(fs.readFileSync(topologyPath, 'utf8'));
        const generatedDir = path.resolve(project.root, 'tests', 'e2e', 'generated');
        const entries = fs.existsSync(generatedDir)
          ? fs.readdirSync(generatedDir, { withFileTypes: true })
          : [];
        const irFiles = entries
          .filter((entry) => entry.isFile() && entry.name.endsWith('.ir.json'))
          .map((entry) => entry.name)
          .sort();
        const specFiles = entries
          .filter((entry) => entry.isFile() && entry.name.endsWith('.spec.ts'))
          .map((entry) => entry.name)
          .sort();
        const irNames = new Set(irFiles);

        // verify 的职责就是发现 IR 有问题，所以它不能被坏 IR 打崩。
        // 走 schema 而不是裸 JSON.parse：unresolved 这类带 .default() 的字段
        // 在输入里可以缺省，裸读会得到 undefined，后面一取 .length 就炸。
        const cases: VerifyCase[] = [];
        const preFindings: VerifyFinding[] = [];
        for (const fileName of irFiles) {
          const stem = fileName.slice(0, -'.ir.json'.length);
          let parsed: StateTransitionIR;
          try {
            const raw = JSON.parse(
              fs.readFileSync(path.join(generatedDir, fileName), 'utf8'),
            );
            const result = StateTransitionIRSchema.safeParse(raw);
            if (!result.success) {
              preFindings.push({
                level: 'error',
                code: 'invalid-ir',
                flowId: typeof raw?.flowId === 'string' ? raw.flowId : stem,
                message:
                  `${fileName} 不符合 IR schema：`
                  + `${result.error.issues
                    .map((issue) => `${issue.path.join('.') || '(根)'} ${issue.message}`)
                    .join('；')}。已跳过这条用例。`,
              });
              continue;
            }
            parsed = result.data;
          } catch (err: any) {
            preFindings.push({
              level: 'error',
              code: 'invalid-ir',
              flowId: stem,
              message: `${fileName} 读不出合法 JSON：${err?.message ?? err}。已跳过这条用例。`,
            });
            continue;
          }
          const specPath = path.join(generatedDir, `${stem}.spec.ts`);
          cases.push({
            flowId: parsed.flowId,
            ir: parsed,
            specContent: fs.existsSync(specPath)
              ? fs.readFileSync(specPath, 'utf8')
              : null,
          });
        }
        caseCount += cases.length;

        const findings: VerifyFinding[] = [
          ...preFindings,
          ...verifyCases(topology, cases, {
            emit: (ir) => emitSpec(ir, readRouterOptions(project.root)),
          }),
        ];
        for (const specFile of specFiles) {
          const stem = specFile.slice(0, -'.spec.ts'.length);
          if (irNames.has(`${stem}.ir.json`)) continue;
          findings.push({
            level: 'error',
            code: 'orphan-spec',
            flowId: stem,
            message: `孤立的生成物 ${specFile} 没有同名 .ir.json；IR 可能已被删除，请恢复 IR 或移除该 spec。`,
          });
        }

        const errors = findings.filter((item) => item.level === 'error');
        const warnings = findings.filter((item) => item.level === 'warning');
        errorCount += errors.length;
        warningCount += warnings.length;

        console.log(`项目 ${project.name}`);
        console.log('错误：');
        if (errors.length === 0) console.log('  无');
        for (const item of errors) console.log(`  [${item.flowId}] ${item.message}`);
        console.log('警告：');
        if (warnings.length === 0) console.log('  无');
        for (const item of warnings) console.log(`  [${item.flowId}] ${item.message}`);
        console.log();
      }

      console.log(`${errorCount} 个错误，${warningCount} 个警告，共 ${caseCount} 条用例`);
      process.exit(errorCount > 0 || (options.strict && warningCount > 0) ? 1 : 0);
    } catch (err: any) {
      fail(err);
    }
  });

program
  .command('heal <spec>')
  .description('Heal failing Playwright spec by inspecting runtime aria snapshot')
  .option('--project <name>', 'IDT project the spec belongs to')
  .action(async (spec: string, options: { project?: string }) => {
    try {
      const { projects } = workspace();
      const project = pick(projects, options.project);
      const result = await heal({
        projectRoot: project.root,
        specPath: path.resolve(process.cwd(), spec),
        baseUrl: projectBaseUrl(project),
      });

      if (result.exitCode === 0) {
        if (result.replaced) {
          console.log(`Successfully healed. New targetName: ${result.newTargetName}`);
        } else {
          console.log('Spec already passed');
        }
        process.exit(0);
      } else {
        console.error(`Heal failed: ${result.reason ?? `exit code ${result.exitCode}`}`);
        process.exit(result.exitCode);
      }
    } catch (err: any) {
      const exitCode = typeof err?.exitCode === 'number' ? err.exitCode : 2;
      console.error(err?.message ?? String(err));
      process.exit(exitCode);
    }
  });

program
  .command('probe <ir>')
  .description('Capture post-action DOM delta and persist unambiguous evidence')
  .option('--project <name>', 'IDT project the IR belongs to')
  .option('--pick <n>', 'Pick a DOM delta candidate by its 1-based index', (value) => Number(value))
  .action(async (ir: string, options: { project?: string; pick?: number }) => {
    try {
      const { projects } = workspace();
      const project = pick(projects, options.project);
      const result = await probe({
        projectRoot: project.root,
        irPath: path.resolve(process.cwd(), ir),
        baseUrl: projectBaseUrl(project),
        pick: options.pick,
      });

      if (result.written && result.delta) {
        console.log(
          `已写入 domDelta：(${result.delta.appearedRole}, ${result.delta.appearedName})`,
        );
      } else if (result.candidates) {
        console.error('发现多个 DOM 增量候选，未修改文件。用 --pick <序号> 选一个：');
        for (const [index, candidate] of result.candidates.entries()) {
          console.error(`  ${index + 1}  (${candidate.role}, ${candidate.name})`);
        }
      } else if (result.reason) {
        const output = result.exitCode === 0 ? console.log : console.error;
        output(result.reason);
      }
      process.exit(result.exitCode);
    } catch (err: any) {
      const exitCode = typeof err?.exitCode === 'number' ? err.exitCode : 2;
      console.error(err?.message ?? String(err));
      process.exit(exitCode);
    }
  });

program
  .command('test [args...]')
  .description('Run the generated Playwright specs of one IDT project')
  .option('--project <name>', 'IDT project to test')
  .allowUnknownOption(true)
  .action((args: string[], options: { project?: string }) => {
    try {
      const { projects } = workspace();
      const project = pick(projects, options.project);

      const configPath = path.join(project.root, '.idt', PROJECT_PLAYWRIGHT_CONFIG);
      if (!fs.existsSync(configPath)) {
        console.error(
          `${project.name} 还没有 Playwright 配置，先执行 idt:sync 生成 .idt/${PROJECT_PLAYWRIGHT_CONFIG}`,
        );
        process.exit(2);
      }

      // 不以 - 开头的才是 spec 路径，其余原样透传给 Playwright。
      // Playwright 把位置参数当正则匹配文件路径，Windows 绝对路径里的 \ 和 :
      // 不是合法正则，所以统一换成相对项目根的 posix 路径。
      const specs = args
        .filter((arg) => !arg.startsWith('-'))
        .map((arg) =>
          path
            .relative(project.root, path.resolve(process.cwd(), arg))
            .split(path.sep)
            .join('/'),
        );
      const passthrough = args.filter((arg) => arg.startsWith('-'));
      const tail = [
        'test',
        ...specs,
        `--config=.idt/${PROJECT_PLAYWRIGHT_CONFIG}`,
        ...passthrough,
      ];

      const cli = playwrightCliEntry(project.root);
      if (!cli) {
        console.error('找不到 playwright，请先在宿主安装 @playwright/test');
        process.exit(2);
      }

      if (!project.implicit) console.log(`项目 ${project.name}`);
      const result = spawnSync(process.execPath, [cli, ...tail], {
        cwd: project.root,
        stdio: 'inherit',
      });
      process.exit(result.status ?? 1);
    } catch (err: any) {
      fail(err);
    }
  });

program
  .command('projects')
  .description('List the IDT projects discovered in this workspace')
  .action(() => {
    try {
      const { env, projects } = workspace();
      console.log(`IDT 根目录 ${env.projectRoot}`);
      for (const project of projects) {
        const where = path.relative(env.projectRoot, project.root) || '.';
        const tag = project.implicit ? '（单项目，无标志）' : '';
        console.log(`  ${project.name}  ${where}  ${tag}`);
        console.log(`      pageGlobs   ${project.pageGlobs.join(', ') || '（空）'}`);
        console.log(`      routerGlobs ${project.routerGlobs.join(', ') || '（空）'}`);
        console.log(`      baseURL     ${projectBaseUrl(project)}`);
        console.log(`      devCommand  ${project.devCommand ?? '（无，生成的配置不带 webServer）'}`);
      }
      process.exit(0);
    } catch (err: any) {
      fail(err);
    }
  });

program.parse(process.argv);
