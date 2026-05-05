import './load-e2e-env.js';

import fsp from 'node:fs/promises';
import path from 'node:path';

import { createProviderRegistry } from '~/agent/registry.js';
import type { AgentExecutionRequest, AgentExecutionSink, AgentExecutor } from '~/agent/types.js';
import { SqliteChannelPreferenceStore } from '~/channel-preference/sqlite-channel-preference-store.js';
import { createDatabase } from '~/db/index.js';
import { env } from '~/env/server.js';
import { createRootLogger } from '~/logger/index.js';
import { SqliteMemoryStore } from '~/memory/memory-store.js';
import { SqliteReconcileStateStore } from '~/memory/reconciler/state-store.js';
import { SqliteSessionStore } from '~/session/sqlite-session-store.js';
import { handleMemoryCommand } from '~/slack/commands/memory-command.js';
import { handleSessionCommand } from '~/slack/commands/session-command.js';
import type { SlashCommandDependencies } from '~/slack/commands/types.js';
import { handleUsageCommand } from '~/slack/commands/usage-command.js';
import { handleWorkspaceCommand } from '~/slack/commands/workspace-command.js';
import { createThreadExecutionRegistry } from '~/slack/execution/thread-execution-registry.js';
import { WorkspaceResolver } from '~/workspace/resolver.js';

import { createLiveApplication } from './live-application.js';
import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import { SlackApiClient } from './slack-api-client.js';

interface SlashCommandE2EResult {
  botUserId: string;
  failureMessage?: string;
  matched: {
    appStarted: boolean;
    memoryCommandWorks: boolean;
    sessionCommandWorks: boolean;
    usageCommandWorks: boolean;
    workspaceCommandWorks: boolean;
  };
  passed: boolean;
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the slash command E2E.');
  }

  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();

  const result: SlashCommandE2EResult = {
    botUserId: botIdentity.user_id,
    matched: {
      appStarted: false,
      memoryCommandWorks: false,
      sessionCommandWorks: false,
      usageCommandWorks: false,
      workspaceCommandWorks: false,
    },
    passed: false,
  };

  const application = createLiveApplication();
  let caughtError: unknown;

  try {
    await application.start();
    await delay(2_000);
    result.matched.appStarted = true;

    const deps = buildCommandDeps();

    testUsageCommand(deps, result);
    testWorkspaceCommand(deps, result);
    testMemoryCommand(deps, result);
    testSessionCommand(deps, result);

    assertResult(result);
    result.passed = true;
    await writeResult(result);

    console.info('Live slash command E2E passed.');
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error);
    caughtError = error;
  } finally {
    await writeResult(result).catch((error) => {
      console.error('Failed to persist result:', error);
    });
    await application.stop().catch((error) => {
      console.error('Failed to stop application:', error);
    });
  }

  if (caughtError) {
    throw caughtError;
  }
}

function buildCommandDeps(): SlashCommandDependencies {
  const dbPath = path.resolve(process.cwd(), env.SESSION_DB_PATH);
  const { db } = createDatabase(dbPath);
  const logger = createRootLogger().withTag('e2e:commands');
  const reconcileStateStore = new SqliteReconcileStateStore(db);
  const memoryStore = new SqliteMemoryStore(db, logger.withTag('memory'), reconcileStateStore);
  const channelPreferenceStore = new SqliteChannelPreferenceStore(
    db,
    logger.withTag('channel-preference'),
  );
  const executors = new Map<string, AgentExecutor>([
    ['claude-code', createCommandOnlyExecutor('claude-code')],
    ['codex-cli', createCommandOnlyExecutor('codex-cli')],
    ['pi-agent', createCommandOnlyExecutor('pi-agent')],
  ]);

  return {
    logger,
    memoryStore,
    providerRegistry: createProviderRegistry(env.AGENT_DEFAULT_PROVIDER, executors),
    sessionStore: new SqliteSessionStore(db, logger.withTag('session')),
    threadExecutionRegistry: createThreadExecutionRegistry(),
    workspaceResolver: new WorkspaceResolver({
      repoRootDir: env.REPO_ROOT_DIR,
      scanDepth: env.REPO_SCAN_DEPTH,
    }),
  };
}

function createCommandOnlyExecutor(providerId: string): AgentExecutor {
  return {
    providerId,
    async drain() {},
    async execute(_request: AgentExecutionRequest, _sink: AgentExecutionSink) {
      throw new Error(`Slash command E2E command-only executor cannot run ${providerId}`);
    },
  };
}

function testUsageCommand(deps: SlashCommandDependencies, result: SlashCommandE2EResult): void {
  const response = handleUsageCommand('', deps);
  if (
    response.text.includes('Sessions:') &&
    response.text.includes('Memories:') &&
    response.text.includes('Repositories:') &&
    response.text.includes('Uptime:')
  ) {
    result.matched.usageCommandWorks = true;
    console.info('/usage output:\n%s', response.text);
  }
}

function testWorkspaceCommand(deps: SlashCommandDependencies, result: SlashCommandE2EResult): void {
  const response = handleWorkspaceCommand('', deps);
  if (
    response.text.includes('Available Workspaces') ||
    response.text.includes('No repositories found')
  ) {
    result.matched.workspaceCommandWorks = true;
    console.info('/workspace output:\n%s', response.text);
  }
}

function testMemoryCommand(deps: SlashCommandDependencies, result: SlashCommandE2EResult): void {
  const response = handleMemoryCommand('', deps);
  if (response.text.includes('Memory Commands')) {
    result.matched.memoryCommandWorks = true;
    console.info('/memory output:\n%s', response.text);
  }
}

function testSessionCommand(deps: SlashCommandDependencies, result: SlashCommandE2EResult): void {
  const response = handleSessionCommand('', deps);
  if (response.text.includes('Session Overview') && response.text.includes('Total sessions:')) {
    result.matched.sessionCommandWorks = true;
    console.info('/session output:\n%s', response.text);
  }
}

function assertResult(result: SlashCommandE2EResult): void {
  const failures: string[] = [];

  if (!result.matched.appStarted) failures.push('application failed to start');
  if (!result.matched.usageCommandWorks)
    failures.push('/usage command did not return expected output');
  if (!result.matched.workspaceCommandWorks)
    failures.push('/workspace command did not return expected output');
  if (!result.matched.memoryCommandWorks)
    failures.push('/memory command did not return expected output');
  if (!result.matched.sessionCommandWorks)
    failures.push('/session command did not return expected output');

  if (failures.length > 0) {
    throw new Error(`Live slash command E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: SlashCommandE2EResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'slash-commands-result.json',
  );
  const absolutePath = path.resolve(process.cwd(), resultPath);
  await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
  await fsp.writeFile(absolutePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export const scenario: LiveE2EScenario = {
  id: 'slash-commands',
  title: 'Slash Commands',
  description:
    'Start the app and verify /usage, /workspace, /memory, and /session commands return expected output.',
  keywords: ['slash', 'commands', 'usage', 'workspace', 'memory', 'session'],
  run: main,
};

runDirectly(scenario);
