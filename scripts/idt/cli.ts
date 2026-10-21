import fs from 'node:fs';
import path from 'node:path';
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
import { generateFlow } from '../../src/idt/core/generate.js';
import { OpenAiClient } from '../../src/idt/core/openai-client.js';
import { emitIrFile } from '../../src/idt/core/emitter.js';
import { heal } from '../../src/idt/core/healer.js';

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
  };
}

function syncOne(project: IdtProject): void {
  extractProjectTopology(project.root, extractOptions(project));
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
        console.log(`${label}Successfully generated .idt/topology.json and .idt/semantic-index.json`);
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
      });

      if (result.exitCode === 0) {
        if (result.replaced) {
          console.log(`Successfully healed. New targetName: ${result.newTargetName}`);
        } else {
          console.log('Spec already passed');
        }
        process.exit(0);
      } else {
        if (result.exitCode === 2) {
          console.error('Heal failed with exit code 2');
        }
        process.exit(result.exitCode);
      }
    } catch (err: any) {
      const exitCode = typeof err?.exitCode === 'number' ? err.exitCode : 2;
      console.error(err?.message ?? String(err));
      process.exit(exitCode);
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
      }
      process.exit(0);
    } catch (err: any) {
      fail(err);
    }
  });

program.parse(process.argv);
