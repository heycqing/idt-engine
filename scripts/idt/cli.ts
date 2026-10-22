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
import { emitIrFile } from '../../src/idt/core/emitter.js';
import { heal } from '../../src/idt/core/healer.js';
import { playwrightCliEntry } from '../../src/idt/core/runner.js';

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
  .option('--force', 'Overwrite existing IR and spec')
  .action(async (options: {
    project?: string;
    limit?: number;
    filter?: string;
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

      // 只挑有确定名字元素的路由：没有可断言的东西，生成出来也是废的
      let routes = Object.entries(topology.routes as Record<string, any>)
        .filter(([, node]) =>
          (node.elements ?? []).some((e: any) => typeof e.name === 'string'),
        )
        .map(([route]) => route)
        .sort();
      if (options.filter) {
        routes = routes.filter((r) => r.includes(options.filter!));
      }
      if (options.limit && options.limit > 0) {
        routes = routes.slice(0, options.limit);
      }

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
