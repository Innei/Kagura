import './load-e2e-env.js';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { env } from '~/env/server.js';

import { createLiveApplication } from './live-application.js';
import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import { SlackApiClient, type SlackConversationRepliesResponse } from './slack-api-client.js';

const FOLLOW_UP_OBSERVATION_WINDOW_MS = 15_000;

interface ThreadForeignMentionIgnoreResult {
  botUserId: string;
  botWithoutMentionReplyTs?: string;
  channelId: string;
  failureMessage?: string;
  firstAssistantReplyText?: string;
  firstAssistantReplyTs?: string;
  followUpBotMessageText?: string;
  followUpBotMessageTs?: string;
  foreignMentionReplyTs?: string;
  matched: {
    botWithoutMentionReplyPosted: boolean;
    firstAssistantReplyObserved: boolean;
    noFollowUpAfterBotWithoutMentionObserved: boolean;
    foreignMentionReplyPosted: boolean;
    noFollowUpAfterForeignMentionObserved: boolean;
  };
  passed: boolean;
  rootMessageTs?: string;
  runId: string;
  triggerUserId: string;
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error(
      'Set SLACK_E2E_ENABLED=true before running the thread foreign mention ignore E2E.',
    );
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error(
      'Thread foreign mention ignore E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.',
    );
  }

  const runId = randomUUID();
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();
  const triggerIdentity = await triggerClient.authTest();

  const result: ThreadForeignMentionIgnoreResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    matched: {
      botWithoutMentionReplyPosted: false,
      firstAssistantReplyObserved: false,
      noFollowUpAfterBotWithoutMentionObserved: false,
      foreignMentionReplyPosted: false,
      noFollowUpAfterForeignMentionObserved: false,
    },
    passed: false,
    runId,
    triggerUserId: triggerIdentity.user_id,
  };

  const application = createLiveApplication();
  let caughtError: unknown;

  try {
    await application.start();
    await delay(3_000);

    const rootPrompt = [
      `<@${botIdentity.user_id}> THREAD_FOREIGN_MENTION_IGNORE ${runId}`,
      'This is a general knowledge question with no code or repository work.',
      `Reply with exactly one line: "THREAD_READY ${runId}".`,
      'Do not use any file or code tools.',
    ].join(' ');

    const rootMessage = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: rootPrompt,
      unfurl_links: false,
      unfurl_media: false,
    });
    result.rootMessageTs = rootMessage.ts;
    console.info('Posted root message: %s', rootMessage.ts);

    const firstReply = await waitForFirstAssistantReply({
      botClient,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      expectedMarker: `THREAD_READY ${runId}`,
      rootTs: rootMessage.ts,
    });
    result.firstAssistantReplyText = firstReply.text;
    result.firstAssistantReplyTs = firstReply.ts;
    result.matched.firstAssistantReplyObserved = true;
    console.info('Observed first assistant reply: %s', firstReply.ts);

    const foreignMentionReply = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: `Please ask <@${triggerIdentity.user_id}> to review this. THREAD_FOREIGN_MENTION ${runId}`,
      thread_ts: rootMessage.ts,
      unfurl_links: false,
      unfurl_media: false,
    });
    result.foreignMentionReplyTs = foreignMentionReply.ts;
    result.matched.foreignMentionReplyPosted = true;
    console.info('Posted foreign mention thread reply: %s', foreignMentionReply.ts);

    const followUpBotMessage = await waitForFollowUpBotMessage({
      botClient,
      botUserId: botIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: foreignMentionReply.ts,
      timeoutMs: FOLLOW_UP_OBSERVATION_WINDOW_MS,
    });

    if (followUpBotMessage) {
      if (followUpBotMessage.text !== undefined) {
        result.followUpBotMessageText = followUpBotMessage.text;
      }
      result.followUpBotMessageTs = followUpBotMessage.ts;
    } else {
      result.matched.noFollowUpAfterForeignMentionObserved = true;
    }

    const botWithoutMentionReply = await botClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: `Bot status update only. THREAD_BOT_NO_MENTION ${runId}`,
      thread_ts: rootMessage.ts,
      unfurl_links: false,
      unfurl_media: false,
    });
    result.botWithoutMentionReplyTs = botWithoutMentionReply.ts;
    result.matched.botWithoutMentionReplyPosted = true;
    console.info(
      'Posted bot-authored thread reply without self mention: %s',
      botWithoutMentionReply.ts,
    );

    const followUpAfterBotWithoutMention = await waitForFollowUpBotMessage({
      botClient,
      botUserId: botIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: botWithoutMentionReply.ts,
      timeoutMs: FOLLOW_UP_OBSERVATION_WINDOW_MS,
    });

    if (!followUpAfterBotWithoutMention) {
      result.matched.noFollowUpAfterBotWithoutMentionObserved = true;
    } else if (!result.followUpBotMessageTs) {
      if (followUpAfterBotWithoutMention.text !== undefined) {
        result.followUpBotMessageText = followUpAfterBotWithoutMention.text;
      }
      result.followUpBotMessageTs = followUpAfterBotWithoutMention.ts;
    }

    await writeResult(result);
    assertResult(result);
    result.passed = true;
    await writeResult(result);

    console.info('Live thread foreign mention ignore E2E passed.');
    console.info('Root thread: %s', result.rootMessageTs);
    console.info('First assistant reply: %s', result.firstAssistantReplyTs);
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

async function waitForFirstAssistantReply(input: {
  botClient: SlackApiClient;
  channelId: string;
  expectedMarker: string;
  rootTs: string;
}): Promise<{ text: string; ts: string }> {
  const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const replies = await input.botClient.conversationReplies({
      channel: input.channelId,
      inclusive: true,
      limit: 50,
      ts: input.rootTs,
    });

    const assistantReply = replies.messages?.find((message) => {
      if (!message.ts || message.ts === input.rootTs || typeof message.text !== 'string') {
        return false;
      }

      return message.text.includes(input.expectedMarker);
    });

    if (assistantReply?.text && assistantReply.ts) {
      return {
        text: assistantReply.text,
        ts: assistantReply.ts,
      };
    }

    await delay(2_500);
  }

  throw new Error('Timed out waiting for the first assistant reply.');
}

async function waitForFollowUpBotMessage(input: {
  botClient: SlackApiClient;
  botUserId: string;
  channelId: string;
  rootTs: string;
  sinceTs: string;
  timeoutMs: number;
}): Promise<{ text?: string; ts: string } | undefined> {
  const deadline = Date.now() + input.timeoutMs;

  while (Date.now() < deadline) {
    const replies = await input.botClient.conversationReplies({
      channel: input.channelId,
      inclusive: true,
      limit: 50,
      ts: input.rootTs,
    });

    const followUp = findBotMessageAfterTs(replies, input.botUserId, input.sinceTs);
    if (followUp) {
      return followUp;
    }

    await delay(2_500);
  }

  return undefined;
}

function findBotMessageAfterTs(
  replies: SlackConversationRepliesResponse,
  botUserId: string,
  sinceTs: string,
): { text?: string; ts: string } | undefined {
  return replies.messages?.find((message) => {
    if (!message.ts || !isTsAfter(message.ts, sinceTs)) {
      return false;
    }

    return message.user === botUserId || Boolean(message.bot_id);
  }) as { text?: string; ts: string } | undefined;
}

function isTsAfter(candidate: string, reference: string): boolean {
  return Number(candidate) > Number(reference);
}

function assertResult(result: ThreadForeignMentionIgnoreResult): void {
  const failures: string[] = [];

  if (!result.matched.firstAssistantReplyObserved) {
    failures.push('initial assistant reply was not observed');
  }
  if (!result.matched.foreignMentionReplyPosted) {
    failures.push('foreign mention thread reply was not posted');
  }
  if (!result.matched.noFollowUpAfterForeignMentionObserved) {
    failures.push(
      `bot sent a follow-up after the foreign mention reply (${result.followUpBotMessageTs ?? 'unknown ts'})`,
    );
  }
  if (!result.matched.botWithoutMentionReplyPosted) {
    failures.push('bot-authored thread reply without self mention was not posted');
  }
  if (!result.matched.noFollowUpAfterBotWithoutMentionObserved) {
    failures.push(
      `bot sent a follow-up after its own non-mention thread reply (${result.followUpBotMessageTs ?? 'unknown ts'})`,
    );
  }

  if (failures.length > 0) {
    throw new Error(`Live thread foreign mention ignore E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: ThreadForeignMentionIgnoreResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'thread-foreign-mention-ignore-result.json',
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
  id: 'thread-foreign-mention-ignore',
  title: 'Thread Foreign Mention Ignore',
  description:
    'Verify the bot ignores thread replies that mention other users or are posted by the bot itself without a self-mention.',
  keywords: ['thread', 'foreign', 'mention', 'ignore', 'reply', 'bot-self'],
  run: main,
};

runDirectly(scenario);
