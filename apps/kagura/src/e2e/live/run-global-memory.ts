import './load-e2e-env.js';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';

import { env } from '~/env/server.js';

import { createLiveApplication } from './live-application.js';
import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import {
  SlackApiClient,
  type SlackConversationRepliesResponse,
  type SlackPostedMessageResponse,
} from './slack-api-client.js';

interface GlobalMemoryE2EResult {
  botUserId: string;
  channelId: string;
  crossSessionReplyText?: string;
  crossSessionReplyTs?: string;
  failureMessage?: string;
  firstReplyText?: string;
  firstReplyTs?: string;
  matched: {
    firstReplyObserved: boolean;
    globalMemoryPersisted: boolean;
    crossSessionRecallObserved: boolean;
  };
  passed: boolean;
  recallMarker: string;
  rootMessageTs?: string;
  runId: string;
  secondRootMessageTs?: string;
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the global memory E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error(
      'Live global memory E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.',
    );
  }

  const runId = randomUUID();
  const recallMarker = `GLOBAL_MEMORY_E2E_MARKER ${runId}`;
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();

  const result: GlobalMemoryE2EResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    matched: {
      firstReplyObserved: false,
      globalMemoryPersisted: false,
      crossSessionRecallObserved: false,
    },
    passed: false,
    recallMarker,
    runId,
  };

  let application = createLiveApplication();
  let caughtError: unknown;

  try {
    await application.start();
    await delay(3_000);

    await runPhaseOne({
      botClient,
      botUserId: botIdentity.user_id,
      recallMarker,
      result,
      runId,
      triggerClient,
    });
    await writeResult(result);
    assertPhaseOne(result);

    console.info('Phase 1 passed — global memory saved without workspace.');

    await application.stop();
    application = createLiveApplication();
    await application.start();
    await delay(3_000);

    await runPhaseTwo({
      botClient,
      botUserId: botIdentity.user_id,
      recallMarker,
      result,
      runId,
      triggerClient,
    });
    assertPhaseTwo(result);
    result.passed = true;
    await writeResult(result);

    console.info('Live global memory E2E passed.');
    console.info('Phase 1 thread: %s', result.rootMessageTs);
    console.info('Phase 2 thread: %s', result.secondRootMessageTs);
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

async function runPhaseOne(input: {
  botClient: SlackApiClient;
  botUserId: string;
  recallMarker: string;
  result: GlobalMemoryE2EResult;
  runId: string;
  triggerClient: SlackApiClient;
}): Promise<void> {
  const prompt = [
    `<@${input.botUserId}> GLOBAL_MEMORY_E2E ${input.runId}`,
    'This is a general question, no code or repository involved.',
    `Before your reply, call save_memory with category "decision", scope "global", and content exactly "${input.recallMarker}".`,
    'Do not paraphrase the saved memory content.',
    `Reply with exactly one line: "GLOBAL_MEMORY_SAVE_OK ${input.runId}".`,
    'Do not use any file or code tools.',
  ].join(' ');

  const rootMessage = await input.triggerClient.postMessage({
    channel: env.SLACK_E2E_CHANNEL_ID!,
    text: prompt,
    unfurl_links: false,
    unfurl_media: false,
  });
  input.result.rootMessageTs = rootMessage.ts;
  console.info('Phase 1: posted root message %s', rootMessage.ts);

  const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const replies = await input.botClient.conversationReplies({
      channel: env.SLACK_E2E_CHANNEL_ID!,
      inclusive: true,
      limit: 50,
      ts: rootMessage.ts,
    });

    const reply = findReply(replies, rootMessage, input.runId, 'GLOBAL_MEMORY_SAVE_OK');
    if (reply) {
      input.result.firstReplyText = reply.text;
      input.result.firstReplyTs = reply.ts;
      input.result.matched.firstReplyObserved = true;
    }

    const savedMemories = readGlobalMemories(input.recallMarker);
    if (savedMemories.length > 0) {
      input.result.matched.globalMemoryPersisted = true;
    }

    if (input.result.matched.firstReplyObserved && input.result.matched.globalMemoryPersisted) {
      break;
    }

    await delay(2_500);
  }
}

async function runPhaseTwo(input: {
  botClient: SlackApiClient;
  botUserId: string;
  recallMarker: string;
  result: GlobalMemoryE2EResult;
  runId: string;
  triggerClient: SlackApiClient;
}): Promise<void> {
  const prompt = [
    `<@${input.botUserId}> GLOBAL_MEMORY_RECALL_E2E ${input.runId}`,
    'This is a general question, no code or repository involved.',
    'Use the recall_memory tool with scope "global" to retrieve previous memories.',
    `Find the memory that contains the run id "${input.runId}" and return it exactly.`,
    `Reply with exactly one line: "GLOBAL_MEMORY_RECALL_OK ${input.runId}" followed by the exact marker text.`,
    'Do not use any file or code tools.',
  ].join(' ');

  const rootMessage = await input.triggerClient.postMessage({
    channel: env.SLACK_E2E_CHANNEL_ID!,
    text: prompt,
    unfurl_links: false,
    unfurl_media: false,
  });
  input.result.secondRootMessageTs = rootMessage.ts;
  console.info('Phase 2: posted root message %s', rootMessage.ts);

  const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const replies = await input.botClient.conversationReplies({
      channel: env.SLACK_E2E_CHANNEL_ID!,
      inclusive: true,
      limit: 50,
      ts: rootMessage.ts,
    });

    const reply = findRecallReply(replies, rootMessage, input.runId, input.recallMarker);
    if (reply) {
      input.result.crossSessionReplyText = reply.text;
      input.result.crossSessionReplyTs = reply.ts;
      input.result.matched.crossSessionRecallObserved = true;
      break;
    }

    await delay(2_500);
  }
}

function findReply(
  replies: SlackConversationRepliesResponse,
  rootMessage: SlackPostedMessageResponse,
  runId: string,
  marker: string,
): { text: string; ts: string } | undefined {
  return replies.messages?.find((message) => {
    if (!message.ts || message.ts === rootMessage.ts) return false;
    return typeof message.text === 'string' && message.text.includes(`${marker} ${runId}`);
  }) as { text: string; ts: string } | undefined;
}

function findRecallReply(
  replies: SlackConversationRepliesResponse,
  rootMessage: SlackPostedMessageResponse,
  runId: string,
  recallMarker: string,
): { text: string; ts: string } | undefined {
  return replies.messages?.find((message) => {
    if (!message.ts || message.ts === rootMessage.ts || typeof message.text !== 'string') {
      return false;
    }
    return (
      message.text.includes(`GLOBAL_MEMORY_RECALL_OK ${runId}`) &&
      message.text.includes(recallMarker)
    );
  }) as { text: string; ts: string } | undefined;
}

function readGlobalMemories(marker: string): Array<{ id: string }> {
  const dbPath = path.resolve(process.cwd(), env.SESSION_DB_PATH);
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    const statement = sqlite.prepare(`
      SELECT id
      FROM memories
      WHERE repo_id IS NULL
        AND category = 'decision'
        AND content = @marker
      ORDER BY created_at DESC
      LIMIT 5
    `);
    return statement.all({ marker }) as Array<{ id: string }>;
  } catch {
    return [];
  } finally {
    sqlite.close();
  }
}

function assertPhaseOne(result: GlobalMemoryE2EResult): void {
  const failures: string[] = [];
  if (!result.matched.firstReplyObserved) {
    failures.push('assistant did not reply with save confirmation');
  }
  if (!result.matched.globalMemoryPersisted) {
    failures.push('global memory was not persisted to database (repo_id IS NULL)');
  }
  if (failures.length > 0) {
    throw new Error(`Global memory E2E phase 1 failed: ${failures.join('; ')}`);
  }
}

function assertPhaseTwo(result: GlobalMemoryE2EResult): void {
  if (!result.matched.crossSessionRecallObserved) {
    throw new Error(
      'Global memory E2E phase 2 failed: cross-session global memory recall not observed',
    );
  }
}

async function writeResult(result: GlobalMemoryE2EResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'global-memory-result.json',
  );
  const absolutePath = path.resolve(process.cwd(), resultPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export const scenario: LiveE2EScenario = {
  id: 'global-memory',
  title: 'Global Memory Cross-Session',
  description:
    'Two-phase test: save a global memory without workspace, then recall it in a new session to verify cross-session global memory works.',
  keywords: ['global', 'memory', 'cross-session', 'no-workspace', 'recall', 'save'],
  run: main,
};

runDirectly(scenario);
