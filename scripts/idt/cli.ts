import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { extractProjectTopology } from '../../src/idt/extract/topology.js';
import { generateFlow } from '../../src/idt/core/generate.js';
import { OpenAiClient } from '../../src/idt/core/openai-client.js';
import { emitIrFile } from '../../src/idt/core/emitter.js';
import { heal } from '../../src/idt/core/healer.js';

const program = new Command();

program
  .command('sync')
  .description('Sync project topology and semantic index')
  .action(() => {
    try {
      const projectRoot = process.cwd();
      extractProjectTopology(projectRoot);
      console.log('Successfully generated .idt/topology.json and .idt/semantic-index.json');
      process.exit(0);
    } catch (err: any) {
      const exitCode = typeof err?.exitCode === 'number' ? err.exitCode : 1;
      console.error(err?.message ?? String(err));
      process.exit(exitCode);
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
      if (!process.env.OPENAI_API_KEY) {
        console.error('OPENAI_API_KEY environment variable is not set');
        process.exit(2);
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
        apiKey: process.env.OPENAI_API_KEY,
        baseUrl: process.env.OPENAI_BASE_URL,
        modelName: process.env.IDT_MODEL_NAME,
      });

      const result = await generateFlow({
        projectRoot: process.cwd(),
        intent,
        proseCase,
        model: client,
        force: options.force,
        yes: options.yes,
      });

      process.exit(result.exitCode);
    } catch (err: any) {
      const exitCode = typeof err?.exitCode === 'number' ? err.exitCode : 1;
      console.error(err?.message ?? String(err));
      process.exit(exitCode);
    }
  });

program
  .command('emit <ir>')
  .description('Emit Playwright spec from State Transition IR')
  .action((ir: string) => {
    try {
      const projectRoot = process.cwd();
      const result = emitIrFile(projectRoot, ir);
      console.log(`Successfully emitted spec: ${result.specPath}`);
      process.exit(0);
    } catch (err: any) {
      const exitCode = typeof err?.exitCode === 'number' ? err.exitCode : 1;
      console.error(err?.message ?? String(err));
      process.exit(exitCode);
    }
  });

program
  .command('heal <spec>')
  .description('Heal failing Playwright spec by inspecting runtime aria snapshot')
  .action(async (spec: string) => {
    try {
      const projectRoot = process.cwd();
      const result = await heal({
        projectRoot,
        specPath: spec,
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
