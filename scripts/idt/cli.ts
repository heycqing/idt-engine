import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import {
  IDT_ENV_FILE,
  loadIdtProjectEnv,
  requireModelCredentials,
} from '../../src/idt/config/project-env.js';
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

program
  .command('sync')
  .description('Sync project topology and semantic index')
  .action(() => {
    try {
      const { projectRoot } = loadIdtProjectEnv(process.cwd());
      extractProjectTopology(projectRoot);
      console.log('Successfully generated .idt/topology.json and .idt/semantic-index.json');
      process.exit(0);
    } catch (err: any) {
      fail(err);
    }
  });

program
  .command('gen <intent>')
  .description('Generate State Transition IR and spec from intent')
  .option('--case <file>', 'Prose case file')
  .option('--force', 'Force overwrite existing IR and spec')
  .option('--yes', 'Run tests after generation')
  .action(async (intent: string, options: { case?: string; force?: boolean; yes?: boolean }) => {
    try {
      const projectEnv = loadIdtProjectEnv(process.cwd());
      const credentials = requireModelCredentials(projectEnv);
      if (projectEnv.sourcePath) {
        console.log(`模型配置来自 ${path.relative(projectEnv.projectRoot, projectEnv.sourcePath) || IDT_ENV_FILE}`);
      }

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
        projectRoot: projectEnv.projectRoot,
        intent,
        proseCase,
        model: client,
        force: options.force,
        yes: options.yes,
      });

      process.exit(result.exitCode);
    } catch (err: any) {
      fail(err);
    }
  });

program
  .command('emit <ir>')
  .description('Emit Playwright spec from State Transition IR')
  .action((ir: string) => {
    try {
      const { projectRoot } = loadIdtProjectEnv(process.cwd());
      const result = emitIrFile(projectRoot, path.resolve(process.cwd(), ir));
      console.log(`Successfully emitted spec: ${result.specPath}`);
      process.exit(0);
    } catch (err: any) {
      fail(err);
    }
  });

program
  .command('heal <spec>')
  .description('Heal failing Playwright spec by inspecting runtime aria snapshot')
  .action(async (spec: string) => {
    try {
      const { projectRoot } = loadIdtProjectEnv(process.cwd());
      const result = await heal({
        projectRoot,
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

program.parse(process.argv);
