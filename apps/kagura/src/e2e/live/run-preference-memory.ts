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

interface PreferenceMemoryE2EResult {
  botUserId: string;
  channelId: string;
  failureMessage?: string;
  matched: {
    phaseOneReplyObserved: boolean;
    preferenceMemoryPersisted: boolean;
    phaseTwoReplyObserved: boolean;
    phaseTwoUsesNickname: boolean;
  };
  nickname: string;
  passed: boolean;
  phaseOneReplyText?: string;
  phaseOneReplyTs?: string;
  phaseOneRootTs?: string;
  phaseTwoReplyText?: string;
  phaseTwoReplyTs?: string;
  phaseTwoRootTs?: string;
  runId: string;
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the preference memory E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error(
      'Live preference memory E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.',
    );
  }

  const runId = randomUUID();
  const nickname = `TestBot_${runId.slice(0, 6)}`;
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();

  const result: PreferenceMemoryE2EResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    matched: {
      phaseOneReplyObserved: false,
      preferenceMemoryPersisted: false,
      phaseTwoReplyObserved: false,
      phaseTwoUsesNickname: false,
    },
    nickname,
    passed: false,
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
      nickname,
      result,
      runId,
      triggerClient,
    });
    await writeResult(result);
    assertPhaseOne(result);

    console.info('Phase 1 passed — preference memory saved.');

    await application.stop();
    application = createLiveApplication();
    await application.start();
    await delay(3_000);

    await runPhaseTwo({
      botClient,
      botUserId: botIdentity.user_id,
      nickname,
      result,
      runId,
      triggerClient,
    });
    assertPhaseTwo(result);
    result.passed = true;
    await writeResult(result);

    console.info('Live preference memory E2E passed.');
    console.info('Phase 1 thread: %s', result.phaseOneRootTs);
    console.info('Phase 2 thread: %s', result.phaseTwoRootTs);
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
  nickname: string;
  result: PreferenceMemoryE2EResult;
  runId: string;
  triggerClient: SlackApiClient;
}): Promise<void> {
  const prompt = [
    `<@${input.botUserId}> PREFERENCE_MEMORY_E2E ${input.runId}`,
    `From now on, your name is "${input.nickname}". Remember this as your nickname.`,
    `Reply with exactly one line: "PREFERENCE_SAVE_OK ${input.runId}".`,
    'Do not use any file or code tools.',
  ].join(' ');

  const rootMessage = await input.triggerClient.postMessage({
    channel: env.SLACK_E2E_CHANNEL_ID!,
    text: prompt,
    unfurl_links: false,
    unfurl_media: false,
  });
  input.result.phaseOneRootTs = rootMessage.ts;
  console.info('Phase 1: posted root message %s', rootMessage.ts);

  const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const replies = await input.botClient.conversationReplies({
      channel: env.SLACK_E2E_CHANNEL_ID!,
      inclusive: true,
      limit: 50,
      ts: rootMessage.ts,
    });

    const reply = findReplyWithMarker(replies, rootMessage, `PREFERENCE_SAVE_OK ${input.runId}`);
    if (reply) {
      input.result.phaseOneReplyText = reply.text;
      input.result.phaseOneReplyTs = reply.ts;
      input.result.matched.phaseOneReplyObserved = true;
    }

    const savedPrefs = readPreferenceMemories(input.nickname);
    if (savedPrefs.length > 0) {
      input.result.matched.preferenceMemoryPersisted = true;
    }

    if (
      input.result.matched.phaseOneReplyObserved &&
      input.result.matched.preferenceMemoryPersisted
    ) {
      break;
    }

    await delay(2_500);
  }
}

async function runPhaseTwo(input: {
  botClient: SlackApiClient;
  botUserId: string;
  nickname: string;
  result: PreferenceMemoryE2EResult;
  runId: string;
  triggerClient: SlackApiClient;
}): Promise<void> {
  const prompt = [
    `<@${input.botUserId}> PREFERENCE_RECALL_E2E ${input.runId}`,
    'What is your nickname? Reply with your nickname in the response.',
    `Include the text "PREFERENCE_RECALL_OK ${input.runId}" in your reply.`,
    'Do not use any file or code tools.',
  ].join(' ');

  const rootMessage = await input.triggerClient.postMessage({
    channel: env.SLACK_E2E_CHANNEL_ID!,
    text: prompt,
    unfurl_links: false,
    unfurl_media: false,
  });
  input.result.phaseTwoRootTs = rootMessage.ts;
  console.info('Phase 2: posted root message %s', rootMessage.ts);

  const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const replies = await input.botClient.conversationReplies({
      channel: env.SLACK_E2E_CHANNEL_ID!,
      inclusive: true,
      limit: 50,
      ts: rootMessage.ts,
    });

    for (const message of replies.messages ?? []) {
      if (!message.ts || message.ts === rootMessage.ts || typeof message.text !== 'string') {
        continue;
      }

      if (message.text.includes(`PREFERENCE_RECALL_OK ${input.runId}`)) {
        input.result.phaseTwoReplyText = message.text;
        input.result.phaseTwoReplyTs = message.ts;
        input.result.matched.phaseTwoReplyObserved = true;

        if (message.text.includes(input.nickname)) {
          input.result.matched.phaseTwoUsesNickname = true;
        }
      }
    }

    if (input.result.matched.phaseTwoReplyObserved) {
      break;
    }

    await delay(2_500);
  }
}

function findReplyWithMarker(
  replies: SlackConversationRepliesResponse,
  rootMessage: SlackPostedMessageResponse,
  marker: string,
): { text: string; ts: string } | undefined {
  return replies.messages?.find((message) => {
    if (!message.ts || message.ts === rootMessage.ts) return false;
    return typeof message.text === 'string' && message.text.includes(marker);
  }) as { text: string; ts: string } | undefined;
}

function readPreferenceMemories(nickname: string): Array<{ id: string }> {
  const dbPath = path.resolve(process.cwd(), env.SESSION_DB_PATH);
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    const statement = sqlite.prepare(`
      SELECT id
      FROM memories
      WHERE category = 'preference'
        AND content LIKE @pattern
      ORDER BY created_at DESC
      LIMIT 5
    `);
    return statement.all({ pattern: `%${nickname}%` }) as Array<{ id: string }>;
  } catch {
    return [];
  } finally {
    sqlite.close();
  }
}

function assertPhaseOne(result: PreferenceMemoryE2EResult): void {
  const failures: string[] = [];
  if (!result.matched.phaseOneReplyObserved) {
    failures.push('assistant did not reply with save confirmation');
  }
  if (!result.matched.preferenceMemoryPersisted) {
    failures.push(
      `preference memory containing nickname "${result.nickname}" was not found in database`,
    );
  }
  if (failures.length > 0) {
    throw new Error(`Preference memory E2E phase 1 failed: ${failures.join('; ')}`);
  }
}

function assertPhaseTwo(result: PreferenceMemoryE2EResult): void {
  const failures: string[] = [];
  if (!result.matched.phaseTwoReplyObserved) {
    failures.push('assistant did not reply in phase 2 within timeout');
  }
  if (!result.matched.phaseTwoUsesNickname) {
    failures.push(`assistant reply in phase 2 does not contain nickname "${result.nickname}"`);
  }
  if (failures.length > 0) {
    throw new Error(`Preference memory E2E phase 2 failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: PreferenceMemoryE2EResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'preference-memory-result.json',
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
  id: 'preference-memory',
  title: 'Preference Memory Cross-Session',
  description:
    'Two-phase test: give the bot a nickname and verify it saves as a preference memory, then restart and verify the bot recalls the nickname in a new session.',
  keywords: ['preference', 'memory', 'nickname', 'cross-session', 'identity', 'implicit'],
  run: main,
};

runDirectly(scenario);
