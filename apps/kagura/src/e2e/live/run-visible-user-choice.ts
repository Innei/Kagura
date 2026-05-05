import './load-e2e-env.js';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { env } from '~/env/server.js';

import { createLiveApplication } from './live-application.js';
import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import { SlackApiClient, type SlackConversationRepliesResponse } from './slack-api-client.js';

interface VisibleUserChoiceResult {
  botUserId: string;
  channelId: string;
  choiceReplyTs?: string;
  failureMessage?: string;
  finalReplyText?: string;
  finalReplyTs?: string;
  firstReplyText?: string;
  firstReplyTs?: string;
  matched: {
    finalReplyObserved: boolean;
    firstReplyMentionedUser: boolean;
    firstReplyObserved: boolean;
    firstReplyUsedNumberedChoices: boolean;
    userChoicePosted: boolean;
  };
  passed: boolean;
  rootMessageTs?: string;
  runId: string;
  triggerUserId: string;
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the visible-user-choice E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error(
      'Visible user choice E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.',
    );
  }

  const runId = randomUUID();
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();
  const triggerIdentity = await triggerClient.authTest();

  const result: VisibleUserChoiceResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    matched: {
      finalReplyObserved: false,
      firstReplyMentionedUser: false,
      firstReplyObserved: false,
      firstReplyUsedNumberedChoices: false,
      userChoicePosted: false,
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
      `<@${botIdentity.user_id}> VISIBLE_USER_CHOICE_E2E ${runId}`,
      'This is a Slack interaction test. Do not use code, file, or interactive question tools.',
      'Ask the user to choose one option before proceeding.',
      `Your first reply must include "CHOICE_REQUEST ${runId}", mention <@${triggerIdentity.user_id}>, and list exactly these numbered choices:`,
      '1. Red',
      '2. Green',
      '3. Blue',
      'Stop after asking. Do not answer the choice yet.',
      `After the user replies by mentioning you with a number in this thread, respond with "CHOICE_ACCEPTED ${runId} Green" if they choose 2.`,
    ].join(' ');

    const rootMessage = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: rootPrompt,
      unfurl_links: false,
      unfurl_media: false,
    });
    result.rootMessageTs = rootMessage.ts;
    console.info('Posted visible-user-choice root message: %s', rootMessage.ts);

    const firstReply = await waitForBotReply({
      botClient,
      botUserId: botIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: rootMessage.ts,
      textIncludes: `CHOICE_REQUEST ${runId}`,
    });

    result.firstReplyText = firstReply.text;
    result.firstReplyTs = firstReply.ts;
    result.matched.firstReplyObserved = true;
    result.matched.firstReplyMentionedUser = firstReply.text.includes(
      `<@${triggerIdentity.user_id}>`,
    );
    result.matched.firstReplyUsedNumberedChoices = hasNumberedChoices(firstReply.text);
    console.info('Observed visible choice request: %s', firstReply.ts);

    const choiceReply = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: `<@${botIdentity.user_id}> 2 VISIBLE_USER_CHOICE_REPLY ${runId}`,
      thread_ts: rootMessage.ts,
      unfurl_links: false,
      unfurl_media: false,
    });
    result.choiceReplyTs = choiceReply.ts;
    result.matched.userChoicePosted = true;
    console.info('Posted user choice reply: %s', choiceReply.ts);

    const finalReply = await waitForBotReply({
      botClient,
      botUserId: botIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: choiceReply.ts,
      textIncludes: `CHOICE_ACCEPTED ${runId}`,
    });

    result.finalReplyText = finalReply.text;
    result.finalReplyTs = finalReply.ts;
    result.matched.finalReplyObserved = finalReply.text.includes('Green');
    console.info('Observed final choice reply: %s', finalReply.ts);

    await writeResult(result);
    assertResult(result);
    result.passed = true;
    await writeResult(result);

    console.info('Live visible-user-choice E2E passed.');
    console.info('Root thread: %s', result.rootMessageTs);
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error);
    caughtError = error;
  } finally {
    await writeResult(result).catch((error) => {
      console.error('Failed to persist visible-user-choice result:', error);
    });
    await application.stop().catch((error) => {
      console.error('Failed to stop application:', error);
    });
  }

  if (caughtError) {
    throw caughtError;
  }
}

async function waitForBotReply(input: {
  botClient: SlackApiClient;
  botUserId: string;
  channelId: string;
  rootTs: string;
  sinceTs: string;
  textIncludes: string;
}): Promise<{ text: string; ts: string }> {
  const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const replies = await input.botClient.conversationReplies({
      channel: input.channelId,
      inclusive: true,
      limit: 50,
      ts: input.rootTs,
    });

    const match = findBotMessageAfterTs(
      replies,
      input.botUserId,
      input.sinceTs,
      input.textIncludes,
    );
    if (match) {
      return match;
    }

    await delay(2_500);
  }

  throw new Error(`Timed out waiting for bot reply containing "${input.textIncludes}".`);
}

function findBotMessageAfterTs(
  replies: SlackConversationRepliesResponse,
  botUserId: string,
  sinceTs: string,
  textIncludes: string,
): { text: string; ts: string } | undefined {
  for (const message of replies.messages ?? []) {
    if (!message.ts || !isTsAfter(message.ts, sinceTs)) {
      continue;
    }
    if (message.user !== botUserId && !message.bot_id) {
      continue;
    }
    const text = typeof message.text === 'string' ? message.text : '';
    if (text.includes(textIncludes)) {
      return { text, ts: message.ts };
    }
  }
  return undefined;
}

function hasNumberedChoices(text: string): boolean {
  return (
    /\b1\.\s*red\b/i.test(text) && /\b2\.\s*green\b/i.test(text) && /\b3\.\s*blue\b/i.test(text)
  );
}

function isTsAfter(candidate: string, reference: string): boolean {
  return Number(candidate) > Number(reference);
}

function assertResult(result: VisibleUserChoiceResult): void {
  const failures: string[] = [];

  if (!result.matched.firstReplyObserved) {
    failures.push('assistant did not post the visible choice request');
  }
  if (!result.matched.firstReplyMentionedUser) {
    failures.push('visible choice request did not mention the trigger user');
  }
  if (!result.matched.firstReplyUsedNumberedChoices) {
    failures.push('visible choice request did not include numbered Red/Green/Blue options');
  }
  if (!result.matched.userChoicePosted) {
    failures.push('user choice reply was not posted');
  }
  if (!result.matched.finalReplyObserved) {
    failures.push('assistant did not continue from the visible user choice');
  }

  if (failures.length > 0) {
    throw new Error(`Live visible-user-choice E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: VisibleUserChoiceResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'visible-user-choice-result.json',
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
  id: 'visible-user-choice',
  title: 'Visible User Choice',
  description:
    'Verify the agent asks a Slack-visible numbered choice with an explicit user mention and continues after the user replies.',
  keywords: ['choice', 'visible', 'mention', 'user', 'thread', 'steer'],
  run: main,
};

runDirectly(scenario);
