import fs from 'node:fs';

import { loadConfigJson, loadEnvFile } from './config/env-loader.js';
import { resolveKaguraPaths } from './config/paths.js';
import { buildProgram, type RunHooks } from './router.js';

export type { RunHooks } from './router.js';

export async function runCli(argv: string[], hooks: RunHooks = {}): Promise<number> {
  if (hasDebugFlag(argv)) {
    enableDebugMode();
    printDebugDiagnostics(argv);
  }

  const program = buildProgram(hooks);
  program.exitOverride();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    const e = err as { exitCode?: number; code?: string };
    if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version') return 0;
    if (typeof e.exitCode === 'number') return e.exitCode;
    throw err;
  }
  const exitCode = process.exitCode;
  return typeof exitCode === 'number' ? exitCode : 0;
}

function hasDebugFlag(argv: string[]): boolean {
  return argv.includes('--debug');
}

function enableDebugMode(): void {
  process.env.KAGURA_DEBUG = 'true';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL?.trim() || 'debug';
  process.env.DEBUG = process.env.DEBUG?.trim() || 'kagura:*';
}

function printDebugDiagnostics(argv: string[]): void {
  const paths = resolveKaguraPaths();
  loadEnvFile(paths);
  const config = loadConfigJson(paths);
  const repoRootDir = process.env.REPO_ROOT_DIR?.trim() || config.repoRootDir?.trim();
  const lines = [
    '[kagura:debug] Debug mode enabled',
    `[kagura:debug] argv=${argv.slice(2).join(' ') || '(default start)'}`,
    `[kagura:debug] cwd=${process.cwd()}`,
    `[kagura:debug] node=${process.version}`,
    `[kagura:debug] KAGURA_HOME=${process.env.KAGURA_HOME?.trim() || '(auto)'}`,
    `[kagura:debug] configDir=${paths.configDir}`,
    `[kagura:debug] envFile=${paths.envFile} exists=${fs.existsSync(paths.envFile)}`,
    `[kagura:debug] configJson=${paths.configJsonFile} exists=${fs.existsSync(paths.configJsonFile)}`,
    `[kagura:debug] dataDir=${paths.dataDir}`,
    `[kagura:debug] dbPath=${paths.dbPath}`,
    `[kagura:debug] SLACK_BOT_TOKEN=${present(process.env.SLACK_BOT_TOKEN)}`,
    `[kagura:debug] SLACK_APP_TOKEN=${present(process.env.SLACK_APP_TOKEN)}`,
    `[kagura:debug] SLACK_SIGNING_SECRET=${present(process.env.SLACK_SIGNING_SECRET)}`,
    `[kagura:debug] REPO_ROOT_DIR=${repoRootDir ? 'present' : 'missing'}`,
    `[kagura:debug] LOG_LEVEL=${process.env.LOG_LEVEL}`,
  ];

  process.stderr.write(`${lines.join('\n')}\n`);
}

function present(value: string | undefined): 'present' | 'missing' {
  return value?.trim() ? 'present' : 'missing';
}
