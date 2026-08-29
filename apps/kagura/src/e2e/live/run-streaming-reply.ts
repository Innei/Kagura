import './load-e2e-env.js';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { env } from '~/env/server.js';

import { applyLiveE2EDatabaseMigrations } from './db-migrations.js';
import { createLiveApplication } from './live-application.js';
import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import { SlackApiClient } from './slack-api-client.js';

interface StreamingReplySample {
  hasEndMarker: boolean;
  hasStartMarker: boolean;
  observedAt: string;
  textLength: number;
  ts: string;
}

interface StreamingReplyResult {
  botUserId: string;
  channelId: string;
  failureMessage?: string;
  finalReplyText?: string;
  finalReplyTs?: string;
  matched: {
    completeReplyObserved: boolean;
    noDuplicateCompleteReply: boolean;
    partialReplyObserved: boolean;
    sameMessageSettled: boolean;
  };
  partialReplyTs?: string;
  passed: boolean;
  rootMessageTs?: string;
  runId: string;
  samples: StreamingReplySample[];
}

const POLL_INTERVAL_MS = 750;
const SAMPLE_LIMIT = 20;

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the streaming reply E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error(
      'Live streaming reply E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.',
    );
  }

  const runId = randomUUID();
  const startMarker = `STREAM_START_${runId}`;
  const endMarker = `STREAM_END_${runId}`;
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const triggerIdentity = await triggerClient.authTest();
  const botIdentity = await botClient.authTest();
  const dbPath = e2ePath(`streaming-reply-${runId}.db`);
  const a2aDbPath = e2ePath(`streaming-reply-a2a-${runId}.db`);

  const result: StreamingReplyResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    matched: {
      completeReplyObserved: false,
      noDuplicateCompleteReply: false,
      partialReplyObserved: false,
      sameMessageSettled: false,
    },
    passed: false,
    runId,
    samples: [],
  };

  applyLiveE2EDatabaseMigrations(dbPath);
  // Claude is currently the only provider that emits assistant-message-delta.
  const application = createLiveApplication({
    a2aCoordinatorDbPath: a2aDbPath,
    defaultProviderId: 'claude-code',
    sessionDbPath: dbPath,
    skipManifestSync: true,
  });
  let caughtError: unknown;

  try {
    const body = buildExpectedBody(startMarker, endMarker);
    const prompt = [
      `STREAMING_REPLY_E2E ${runId}`,
      'Reply with exactly the body below. Do not use tools, summarize, omit lines, or wrap it in a code fence.',
      body,
    ].join('\n\n');

    const rootMessage = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: prompt,
      unfurl_links: false,
      unfurl_media: false,
    });
    result.rootMessageTs = rootMessage.ts;
    console.info('Posted root message: %s', rootMessage.ts);

    let executionError: unknown;
    const execution = application
      .dispatchThreadConversation({
        addAcknowledgementReaction: false,
        agentProviderOverride: 'claude-code',
        channelId: env.SLACK_E2E_CHANNEL_ID,
        currentBotUserId: botIdentity.user_id,
        currentBotUserName: botIdentity.user,
        forceNewSession: true,
        logLabel: 'live streaming reply E2E',
        messageTs: rootMessage.ts,
        rootMessageTs: rootMessage.ts,
        teamId: triggerIdentity.team_id,
        text: prompt,
        userId: triggerIdentity.user_id,
      })
      .catch((error: unknown) => {
        executionError = error;
      });

    const completeReplyTimestamps = new Set<string>();
    let completionObservedAt: number | undefined;
    const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (executionError) {
        throw executionError;
      }

      const replies = await botClient.conversationReplies({
        channel: env.SLACK_E2E_CHANNEL_ID,
        inclusive: true,
        limit: 50,
        ts: rootMessage.ts,
      });

      for (const message of replies.messages ?? []) {
        if (!message.ts || message.ts === rootMessage.ts) continue;
        if (message.user !== botIdentity.user_id && !message.bot_id) continue;

        const text = typeof message.text === 'string' ? message.text : '';
        const hasStartMarker = text.includes(startMarker);
        const hasEndMarker = text.includes(endMarker);
        if (!hasStartMarker && !hasEndMarker) continue;

        recordSample(result, {
          hasEndMarker,
          hasStartMarker,
          observedAt: new Date().toISOString(),
          textLength: text.length,
          ts: message.ts,
        });

        if (hasStartMarker && !hasEndMarker) {
          result.partialReplyTs ??= message.ts;
          result.matched.partialReplyObserved = true;
        }

        if (hasStartMarker && hasEndMarker) {
          completeReplyTimestamps.add(message.ts);
          result.finalReplyText = text;
          result.finalReplyTs = message.ts;
          result.matched.completeReplyObserved = true;
          completionObservedAt ??= Date.now();
        }
      }

      if (completionObservedAt && Date.now() - completionObservedAt >= 1_500) {
        result.matched.noDuplicateCompleteReply = completeReplyTimestamps.size === 1;
        result.matched.sameMessageSettled = result.partialReplyTs === result.finalReplyTs;
        break;
      }

      await delay(POLL_INTERVAL_MS);
    }

    await execution;
    if (executionError) {
      throw executionError;
    }

    await writeResult(result);
    assertResult(result);
    result.passed = true;
    await writeResult(result);

    console.info('Live streaming reply E2E passed.');
    console.info('Root thread: %s', result.rootMessageTs);
    console.info('Streamed reply: %s', result.finalReplyTs);
    console.info('Captured stream samples: %d', result.samples.length);
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

function buildExpectedBody(startMarker: string, endMarker: string): string {
  const filler = Array.from(
    { length: 28 },
    (_, index) =>
      `${String(index + 1).padStart(3, '0')} streaming verification line: ` +
      'the same Slack message should grow incrementally without creating a duplicate final reply.',
  );
  return [startMarker, ...filler, endMarker].join('\n');
}

function recordSample(result: StreamingReplyResult, sample: StreamingReplySample): void {
  const previous = result.samples.at(-1);
  if (
    previous?.ts === sample.ts &&
    previous.textLength === sample.textLength &&
    previous.hasEndMarker === sample.hasEndMarker
  ) {
    return;
  }
  result.samples.push(sample);
  if (result.samples.length > SAMPLE_LIMIT) {
    result.samples.shift();
  }
}

function assertResult(result: StreamingReplyResult): void {
  const failures: string[] = [];

  if (!result.matched.partialReplyObserved) {
    failures.push('no incomplete streamed reply containing the start marker was observed');
  }
  if (!result.matched.completeReplyObserved) {
    failures.push('no completed reply containing both stream markers was observed');
  }
  if (!result.matched.sameMessageSettled) {
    failures.push(
      `partial reply ts ${result.partialReplyTs ?? '<missing>'} did not settle as final reply ts ${result.finalReplyTs ?? '<missing>'}`,
    );
  }
  if (!result.matched.noDuplicateCompleteReply) {
    failures.push('more than one completed reply containing both stream markers was observed');
  }

  if (failures.length > 0) {
    throw new Error(`Live streaming reply E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: StreamingReplyResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'streaming-reply-result.json',
  );
  const absolutePath = path.resolve(process.cwd(), resultPath);
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
  id: 'streaming-reply',
  title: 'Streaming Reply',
  description:
    'Verify that Claude incrementally updates one Slack reply and settles that same message without posting a duplicate final response.',
  keywords: ['agent', 'delta', 'stream', 'streaming', 'reply', 'slack'],
  provider: {
    kind: 'specific',
    providerId: 'claude-code',
    reason: 'Claude is currently the only provider that emits assistant-message-delta events.',
  },
  run: main,
};

runDirectly(scenario);
