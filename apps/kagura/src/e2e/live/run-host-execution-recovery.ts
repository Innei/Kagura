import './load-e2e-env.js';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { createApplication } from '~/application.js';
import { createDatabase } from '~/db/index.js';
import { env } from '~/env/server.js';
import { SqlitePersistentExecutionStore } from '~/slack/execution/persistent-execution-store.js';

import { applyLiveE2EDatabaseMigrations } from './db-migrations.js';
import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import { SlackApiClient } from './slack-api-client.js';

interface HostExecutionRecoveryResult {
  botUserId: string;
  channelId: string;
  executionId: string;
  executionStatus: string | undefined;
  failureMessage?: string;
  matched: {
    finalReply: boolean;
    recoveryNotice: boolean;
    terminalDbStatus: boolean;
  };
  passed: boolean;
  recoveryReplyTs?: string;
  rootMessageTs?: string;
  runId: string;
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the host recovery E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error(
      'Live host recovery E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.',
    );
  }

  const runId = randomUUID();
  const executionId = `host-recovery-${runId}`;
  const dbPath = e2ePath(`host-execution-recovery-${runId}.db`);
  const a2aDbPath = e2ePath(`host-execution-recovery-a2a-${runId}.db`);
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();
  const triggerIdentity = await triggerClient.authTest();

  const result: HostExecutionRecoveryResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    executionId,
    executionStatus: undefined,
    matched: {
      finalReply: false,
      recoveryNotice: false,
      terminalDbStatus: false,
    },
    passed: false,
    runId,
  };

  const rootMessage = await triggerClient.postMessage({
    channel: env.SLACK_E2E_CHANNEL_ID,
    text: `HOST_EXECUTION_RECOVERY_E2E anchor ${runId}`,
    unfurl_links: false,
    unfurl_media: false,
  });
  result.rootMessageTs = rootMessage.ts;
  applyLiveE2EDatabaseMigrations(dbPath);
  seedInterruptedExecution({
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    dbPath,
    executionId,
    rootMessageTs: rootMessage.ts,
    runId,
    userId: triggerIdentity.user_id,
  });

  const application = createApplication({
    a2aCoordinatorDbPath: a2aDbPath,
    defaultProviderId: 'codex-cli',
    sessionDbPath: dbPath,
  });
  let caughtError: unknown;

  try {
    await application.start();

    const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const replies = await botClient.conversationReplies({
        channel: env.SLACK_E2E_CHANNEL_ID,
        inclusive: true,
        limit: 50,
        ts: rootMessage.ts,
      });

      for (const message of replies.messages ?? []) {
        if (!message.ts || message.ts === rootMessage.ts) continue;
        const text = typeof message.text === 'string' ? message.text : '';

        if (text.includes('Host restarted during execution; resuming')) {
          result.matched.recoveryNotice = true;
          result.recoveryReplyTs = message.ts;
        }

        if (text.includes(`HOST_EXECUTION_RECOVERY_OK ${runId}`)) {
          result.matched.finalReply = true;
        }
      }

      result.executionStatus = readExecutionStatus(dbPath, executionId);
      result.matched.terminalDbStatus =
        result.executionStatus === 'completed' ||
        result.executionStatus === 'failed' ||
        result.executionStatus === 'stopped';

      if (
        result.matched.recoveryNotice &&
        result.matched.finalReply &&
        result.matched.terminalDbStatus
      ) {
        break;
      }

      await delay(2_500);
    }

    await writeResult(result);
    assertResult(result);
    result.passed = true;
    await writeResult(result);

    console.info('Live host execution recovery E2E passed.');
    console.info('Root thread: %s', result.rootMessageTs);
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

function seedInterruptedExecution(input: {
  botUserId: string;
  channelId: string;
  dbPath: string;
  executionId: string;
  rootMessageTs: string;
  runId: string;
  userId: string;
}): void {
  const { sqlite } = createDatabase(input.dbPath);
  const store = new SqlitePersistentExecutionStore(sqlite);
  store.start({
    channelId: input.channelId,
    executionId: input.executionId,
    messageTs: input.rootMessageTs,
    providerId: 'codex-cli',
    rootMessageTs: input.rootMessageTs,
    startedAt: '2026-05-02T00:00:00.000Z',
    text: [
      `<@${input.botUserId}> HOST_EXECUTION_RECOVERY_E2E ${input.runId}`,
      `This request was interrupted by a host restart.`,
      `Reply with exactly one line: "HOST_EXECUTION_RECOVERY_OK ${input.runId}".`,
      `Do not use any file or code tools. Just reply directly.`,
    ].join(' '),
    threadTs: input.rootMessageTs,
    userId: input.userId,
  });
  sqlite.close();
}

function readExecutionStatus(dbPath: string, executionId: string): string | undefined {
  const { sqlite } = createDatabase(dbPath);
  try {
    const row = sqlite
      .prepare('SELECT status FROM agent_executions WHERE execution_id = ?')
      .get(executionId) as { status?: string } | undefined;
    return row?.status;
  } finally {
    sqlite.close();
  }
}

function assertResult(result: HostExecutionRecoveryResult): void {
  const failures: string[] = [];

  if (!result.matched.recoveryNotice) {
    failures.push('recovery notice was not posted after startup');
  }
  if (!result.matched.finalReply) {
    failures.push(`assistant did not reply with HOST_EXECUTION_RECOVERY_OK ${result.runId}`);
  }
  if (!result.matched.terminalDbStatus) {
    failures.push(
      `execution did not reach terminal DB status; last status=${result.executionStatus}`,
    );
  }

  if (failures.length > 0) {
    throw new Error(`Live host execution recovery E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: HostExecutionRecoveryResult): Promise<void> {
  const absolutePath = e2ePath('host-execution-recovery-result.json');
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

function e2ePath(fileName: string): string {
  return path.resolve(process.cwd(), env.SLACK_E2E_RESULT_PATH.replace(/result\.json$/, fileName));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export const scenario: LiveE2EScenario = {
  id: 'host-execution-recovery',
  provider: {
    kind: 'specific',
    providerId: 'codex-cli',
    reason: 'Seeds a Codex execution record and verifies host recovery.',
  },
  title: 'Host Execution Recovery',
  description:
    'Seed an interrupted execution before Socket Mode startup and verify Kagura resumes it automatically.',
  keywords: ['host', 'execution', 'recovery', 'resume', 'restart', 'codex'],
  run: main,
};

runDirectly(scenario);
