import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  IDT_ENV_EXAMPLE_FILE,
  IDT_ENV_FILE,
  IdtProjectEnvError,
  findIdtProjectRoot,
  loadIdtProjectEnv,
  parseEnvFile,
  requireModelCredentials,
} from './project-env.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'idt-project-env-'));
}

function writeConfig(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'idt.config.ts'), 'export default { pageGlobs: [], localeFiles: [] };\n', 'utf8');
}

describe('project env', () => {
  it('uses the nearest idt.config.ts as the project root', () => {
    const root = tempDir();
    try {
      const outer = path.join(root, 'outer');
      const inner = path.join(outer, 'packages', 'inner');
      writeConfig(outer);
      writeConfig(inner);
      const deep = path.join(inner, 'src', 'views');
      fs.mkdirSync(deep, { recursive: true });

      assert.equal(findIdtProjectRoot(deep), inner);
      assert.equal(findIdtProjectRoot(path.join(outer, 'src')), outer);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to the start directory when no idt.config.ts exists above', () => {
    const root = tempDir();
    try {
      const deep = path.join(root, 'a', 'b');
      fs.mkdirSync(deep, { recursive: true });
      assert.equal(findIdtProjectRoot(deep), deep);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads the project root env file when the cli runs from a subdirectory', () => {
    const root = tempDir();
    try {
      writeConfig(root);
      fs.writeFileSync(
        path.join(root, IDT_ENV_FILE),
        'OPENAI_API_KEY=project-key\nOPENAI_BASE_URL=https://example.com/v1\nIDT_MODEL_NAME=example-model\n',
        'utf8',
      );
      const deep = path.join(root, 'apps', 'web', 'src');
      fs.mkdirSync(deep, { recursive: true });

      const env = loadIdtProjectEnv(deep, {});
      assert.equal(env.projectRoot, root);
      assert.equal(env.sourcePath, path.join(root, IDT_ENV_FILE));
      assert.equal(env.openAiApiKey, 'project-key');
      assert.equal(env.openAiBaseUrl, 'https://example.com/v1');
      assert.equal(env.modelName, 'example-model');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets the project file override process environment variables per field', () => {
    const root = tempDir();
    try {
      writeConfig(root);
      fs.writeFileSync(path.join(root, IDT_ENV_FILE), 'OPENAI_API_KEY=project-key\n', 'utf8');

      const env = loadIdtProjectEnv(root, {
        OPENAI_API_KEY: 'global-key',
        OPENAI_BASE_URL: 'https://global.example.com/v1',
        IDT_MODEL_NAME: 'global-model',
      });
      assert.equal(env.openAiApiKey, 'project-key');
      assert.equal(env.openAiBaseUrl, 'https://global.example.com/v1');
      assert.equal(env.modelName, 'global-model');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to process environment variables without a project file', () => {
    const root = tempDir();
    try {
      writeConfig(root);
      const env = loadIdtProjectEnv(root, { OPENAI_API_KEY: 'global-key' });
      assert.equal(env.sourcePath, null);
      assert.equal(env.openAiApiKey, 'global-key');
      assert.equal(env.openAiBaseUrl, undefined);
      assert.equal(env.modelName, undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats an empty project value as absent', () => {
    const root = tempDir();
    try {
      writeConfig(root);
      fs.writeFileSync(path.join(root, IDT_ENV_FILE), 'OPENAI_API_KEY=\n', 'utf8');
      const env = loadIdtProjectEnv(root, { OPENAI_API_KEY: 'global-key' });
      assert.equal(env.openAiApiKey, 'global-key');
      assert.equal(env.sourcePath, null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('parses comments, quotes, BOM, equals signs and CRLF', () => {
    const content =
      '﻿# comment\r\n' +
      '\r\n' +
      '   # indented comment\r\n' +
      'OPENAI_API_KEY="quoted-key"\r\n' +
      "OPENAI_BASE_URL='https://example.com/v1?a=1&b=2'\r\n" +
      '  IDT_MODEL_NAME =  spaced-model  \r\n';
    const parsed = parseEnvFile(content);
    assert.deepEqual(parsed, {
      OPENAI_API_KEY: 'quoted-key',
      OPENAI_BASE_URL: 'https://example.com/v1?a=1&b=2',
      IDT_MODEL_NAME: 'spaced-model',
    });
  });

  it('ignores unknown fields and unsupported syntax', () => {
    const parsed = parseEnvFile(
      [
        'export OPENAI_API_KEY=exported',
        'SOME_OTHER_SECRET=should-be-dropped',
        'OPENAI_API_KEY=$(whoami)',
        'NO_EQUALS_SIGN',
        '=leading-equals',
      ].join('\n'),
    );
    assert.deepEqual(Object.keys(parsed), ['OPENAI_API_KEY']);
    assert.equal(parsed.OPENAI_API_KEY, '$(whoami)');
  });

  it('requires a key for gen and never echoes configuration values', () => {
    const root = tempDir();
    try {
      writeConfig(root);
      const env = loadIdtProjectEnv(root, {});
      assert.throws(
        () => requireModelCredentials(env),
        (err: unknown) => {
          assert.ok(err instanceof IdtProjectEnvError);
          assert.equal(err.exitCode, 2);
          assert.match(err.message, new RegExp(IDT_ENV_FILE.replace(/\./g, '\.')));
          assert.match(err.message, new RegExp(IDT_ENV_EXAMPLE_FILE.replace(/\./g, '\.')));
          return true;
        },
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns credentials for gen when the project file supplies them', () => {
    const root = tempDir();
    try {
      writeConfig(root);
      fs.writeFileSync(
        path.join(root, IDT_ENV_FILE),
        'OPENAI_API_KEY=project-key\nIDT_MODEL_NAME=example-model\n',
        'utf8',
      );
      const credentials = requireModelCredentials(loadIdtProjectEnv(root, {}));
      assert.deepEqual(credentials, {
        apiKey: 'project-key',
        baseUrl: undefined,
        modelName: 'example-model',
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps sync, emit and heal usable without any model configuration', () => {
    const root = tempDir();
    try {
      writeConfig(root);
      const env = loadIdtProjectEnv(root, {});
      assert.equal(env.projectRoot, root);
      assert.equal(env.openAiApiKey, '');
      assert.equal(env.sourcePath, null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
