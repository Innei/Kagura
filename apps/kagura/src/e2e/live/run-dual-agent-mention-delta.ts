import './load-e2e-env.js';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { env } from '~/env/server.js';

import { applyLiveE2EDatabaseMigrations } from './db-migrations.js';
import { createLiveApplication } from './live-application.js';
import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import { SlackApiClient, type SlackConversationRepliesResponse } from './slack-api-client.js';

interface DualAgentMentionDeltaResult {
  appOneBotUserId: string;
  appTwoBotUserId: string;
  channelId: string;
  failureMessage?: string;
  finalReplyText?: string;
  finalReplyTs?: string;
  ignoredMessageTs?: string;
  joinMessageTs?: string;
  joinReplyText?: string;
  joinReplyTs?: string;
  matched: {
    appOneFinalReplyObserved: boolean;
    appOneReadyObserved: boolean;
    appTwoSilentBeforeJoinObserved: boolean;
    appTwoIgnoredMessagePosted: boolean;
    appTwoLateJoinHistoryObserved: boolean;
    appTwoJoinedByUser: boolean;
    appTwoJoinReplyObserved: boolean;
    appTwoMentionMessagePosted: boolean;
    noAppOneReplyBeforeMentionObserved: boolean;
  };
  mentionMessageTs?: string;
  passed: boolean;
  preJoinUnexpectedAppTwoText?: string;
  preJoinUnexpectedAppTwoTs?: string;
  readyReplyText?: string;
  readyReplyTs?: string;
  rootMessageTs?: string;
  runId: string;
}

const IGNORED_CODEWORD = 'ORCHID';
const PREJOIN_CODEWORD = 'LOTUS';
const NO_MENTION_OBSERVATION_WINDOW_MS = 12_000;

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the dual-agent E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error(
      'Dual-agent mention delta E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.',
    );
  }

  if (!env.SLACK_BOT_2_TOKEN || !env.SLACK_APP_2_TOKEN || !env.SLACK_SIGNING_2_SECRET) {
    throw new Error(
      'Dual-agent mention delta E2E requires SLACK_BOT_2_TOKEN, SLACK_APP_2_TOKEN, and SLACK_SIGNING_2_SECRET.',
    );
  }

  const runId = randomUUID();
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const appOneClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const appTwoClient = new SlackApiClient(env.SLACK_BOT_2_TOKEN);
  const appOneIdentity = await appOneClient.authTest();
  const appTwoIdentity = await appTwoClient.authTest();
  const appTwoSessionDbPath = withPathSuffix(env.SESSION_DB_PATH, 'app2');
  applyLiveE2EDatabaseMigrations(appTwoSessionDbPath);

  const result: DualAgentMentionDeltaResult = {
    appOneBotUserId: appOneIdentity.user_id,
    appTwoBotUserId: appTwoIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    matched: {
      appOneFinalReplyObserved: false,
      appOneReadyObserved: false,
      appTwoSilentBeforeJoinObserved: false,
      appTwoIgnoredMessagePosted: false,
      appTwoLateJoinHistoryObserved: false,
      appTwoJoinedByUser: false,
      appTwoJoinReplyObserved: false,
      appTwoMentionMessagePosted: false,
      noAppOneReplyBeforeMentionObserved: false,
    },
    passed: false,
    runId,
  };

  const appOne = createLiveApplication({ instanceLabel: 'bootstrap:app1' });
  const appTwo = createLiveApplication({
    executionProbePath: withPathSuffix(env.SLACK_E2E_EXECUTION_PROBE_PATH, 'app2'),
    instanceLabel: 'bootstrap:app2',
    sessionDbPath: appTwoSessionDbPath,
    skipManifestSync: true,
    slackCredentials: {
      appToken: env.SLACK_APP_2_TOKEN,
      botToken: env.SLACK_BOT_2_TOKEN,
      signingSecret: env.SLACK_SIGNING_2_SECRET,
    },
    statusProbePath: withPathSuffix(env.SLACK_E2E_STATUS_PROBE_PATH, 'app2'),
  });
  let caughtError: unknown;

  try {
    await appOne.start();
    await appTwo.start();
    await delay(3_000);

    const rootPrompt = [
      `<@${appOneIdentity.user_id}> DUAL_AGENT_MENTION_DELTA ${runId}`,
      'This is a Slack routing test. Do not use code, file, or interactive question tools.',
      `Pre-join history marker for the later agent: DUAL_AGENT_PREJOIN_ROOT_CONTEXT ${runId} codeword ${PREJOIN_CODEWORD}.`,
      `Reply with exactly "DUAL_AGENT_READY ${runId}".`,
      `Later, after the user explicitly mentions another Slack app in this thread, if that app mentions you with DUAL_AGENT_TRIGGER ${runId}, inspect this thread history.`,
      `If you can see DUAL_AGENT_IGNORED_CONTEXT ${runId} and the codeword ${IGNORED_CODEWORD}, reply exactly "DUAL_AGENT_SEEN ${runId} ${IGNORED_CODEWORD}".`,
    ].join(' ');

    const rootMessage = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: rootPrompt,
      unfurl_links: false,
      unfurl_media: false,
    });
    result.rootMessageTs = rootMessage.ts;
    console.info('Posted dual-agent root message: %s', rootMessage.ts);

    const readyReply = await waitForBotReply({
      botClient: appOneClient,
      botUserId: appOneIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: rootMessage.ts,
      textIncludes: `DUAL_AGENT_READY ${runId}`,
    });
    result.readyReplyText = readyReply.text;
    result.readyReplyTs = readyReply.ts;
    result.matched.appOneReadyObserved = true;
    console.info('Observed app one ready reply: %s', readyReply.ts);

    const preJoinAppTwoMessage = await waitForOptionalBotMessage({
      botClient: appTwoClient,
      botUserId: appTwoIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: rootMessage.ts,
      timeoutMs: NO_MENTION_OBSERVATION_WINDOW_MS,
    });
    result.matched.appTwoSilentBeforeJoinObserved = !preJoinAppTwoMessage;
    if (preJoinAppTwoMessage) {
      result.preJoinUnexpectedAppTwoText = preJoinAppTwoMessage.text;
      result.preJoinUnexpectedAppTwoTs = preJoinAppTwoMessage.ts;
    }

    const joinMessage = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: [
        `<@${appTwoIdentity.user_id}> DUAL_AGENT_JOIN ${runId}`,
        'You are now explicitly added to this thread by the user.',
        `If you can see DUAL_AGENT_PREJOIN_ROOT_CONTEXT ${runId} and the codeword ${PREJOIN_CODEWORD} from before you joined, reply exactly "DUAL_AGENT_JOINED ${runId} ${PREJOIN_CODEWORD}".`,
      ].join(' '),
      thread_ts: rootMessage.ts,
      unfurl_links: false,
      unfurl_media: false,
    });
    result.joinMessageTs = joinMessage.ts;
    result.matched.appTwoJoinedByUser = true;
    console.info('Posted user join mention for app two: %s', joinMessage.ts);

    const joinReply = await waitForBotReply({
      botClient: appTwoClient,
      botUserId: appTwoIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: joinMessage.ts,
      textIncludes: `DUAL_AGENT_JOINED ${runId} ${PREJOIN_CODEWORD}`,
    });
    result.joinReplyText = joinReply.text;
    result.joinReplyTs = joinReply.ts;
    result.matched.appTwoJoinReplyObserved = true;
    result.matched.appTwoLateJoinHistoryObserved = true;
    console.info('Observed app two join reply: %s', joinReply.ts);

    const ignoredMessage = await appTwoClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: [
        `DUAL_AGENT_IGNORED_CONTEXT ${runId}`,
        `codeword ${IGNORED_CODEWORD}`,
        'This bot-authored message intentionally does not mention the first app.',
      ].join(' '),
      thread_ts: rootMessage.ts,
      unfurl_links: false,
      unfurl_media: false,
    });
    result.ignoredMessageTs = ignoredMessage.ts;
    result.matched.appTwoIgnoredMessagePosted = true;
    console.info('Posted app two non-mention context message: %s', ignoredMessage.ts);

    const prematureReply = await waitForOptionalBotReply({
      botClient: appOneClient,
      botUserId: appOneIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: ignoredMessage.ts,
      textIncludes: `DUAL_AGENT_SEEN ${runId}`,
      timeoutMs: NO_MENTION_OBSERVATION_WINDOW_MS,
    });
    result.matched.noAppOneReplyBeforeMentionObserved = !prematureReply;
    if (prematureReply) {
      result.finalReplyText = prematureReply.text;
      result.finalReplyTs = prematureReply.ts;
    }

    const mentionMessage = await appTwoClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: [
        `<@${appOneIdentity.user_id}> DUAL_AGENT_TRIGGER ${runId}`,
        'Please inspect the Slack thread history since your previous turn.',
        `If you can see DUAL_AGENT_IGNORED_CONTEXT ${runId} and ${IGNORED_CODEWORD},`,
        `reply exactly "DUAL_AGENT_SEEN ${runId} ${IGNORED_CODEWORD}".`,
      ].join(' '),
      thread_ts: rootMessage.ts,
      unfurl_links: false,
      unfurl_media: false,
    });
    result.mentionMessageTs = mentionMessage.ts;
    result.matched.appTwoMentionMessagePosted = true;
    console.info('Posted app two mention trigger: %s', mentionMessage.ts);

    const finalReply = await waitForBotReply({
      botClient: appOneClient,
      botUserId: appOneIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: mentionMessage.ts,
      textIncludes: `DUAL_AGENT_SEEN ${runId} ${IGNORED_CODEWORD}`,
    });
    result.finalReplyText = finalReply.text;
    result.finalReplyTs = finalReply.ts;
    result.matched.appOneFinalReplyObserved = true;
    console.info('Observed app one final delta reply: %s', finalReply.ts);

    await delay(15_000);

    await writeResult(result);
    assertResult(result);
    result.passed = true;
    await writeResult(result);

    console.info('Live dual-agent mention delta E2E passed.');
    console.info('Root thread: %s', result.rootMessageTs);
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error);
    caughtError = error;
  } finally {
    await writeResult(result).catch((error) => {
      console.error('Failed to persist dual-agent result:', error);
    });
    await Promise.allSettled([appTwo.stop(), appOne.stop()]);
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
      limit: 80,
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

async function waitForOptionalBotReply(input: {
  botClient: SlackApiClient;
  botUserId: string;
  channelId: string;
  rootTs: string;
  sinceTs: string;
  textIncludes: string;
  timeoutMs: number;
}): Promise<{ text: string; ts: string } | undefined> {
  const deadline = Date.now() + input.timeoutMs;

  while (Date.now() < deadline) {
    const replies = await input.botClient.conversationReplies({
      channel: input.channelId,
      inclusive: true,
      limit: 80,
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

  return undefined;
}

async function waitForOptionalBotMessage(input: {
  botClient: SlackApiClient;
  botUserId: string;
  channelId: string;
  rootTs: string;
  sinceTs: string;
  textIncludes?: string;
  timeoutMs: number;
}): Promise<{ text: string; ts: string } | undefined> {
  const deadline = Date.now() + input.timeoutMs;

  while (Date.now() < deadline) {
    const replies = await input.botClient.conversationReplies({
      channel: input.channelId,
      inclusive: true,
      limit: 80,
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

  return undefined;
}

function findBotMessageAfterTs(
  replies: SlackConversationRepliesResponse,
  botUserId: string,
  sinceTs: string,
  textIncludes?: string,
): { text: string; ts: string } | undefined {
  for (const message of replies.messages ?? []) {
    if (!message.ts || !isTsAfter(message.ts, sinceTs)) {
      continue;
    }
    if (message.user !== botUserId) {
      continue;
    }
    const text = typeof message.text === 'string' ? message.text : '';
    if (!textIncludes || text.includes(textIncludes)) {
      return { text, ts: message.ts };
    }
  }
  return undefined;
}

function isTsAfter(candidate: string, reference: string): boolean {
  return Number(candidate) > Number(reference);
}

function withPathSuffix(rawPath: string, suffix: string): string {
  const parsed = path.parse(rawPath);
  return path.join(parsed.dir, `${parsed.name}-${suffix}${parsed.ext}`);
}

function assertResult(result: DualAgentMentionDeltaResult): void {
  const failures: string[] = [];

  if (!result.matched.appOneReadyObserved) {
    failures.push('first app did not post the ready reply');
  }
  if (!result.matched.appTwoSilentBeforeJoinObserved) {
    failures.push('second app posted in the thread before the user explicitly added it');
  }
  if (!result.matched.appTwoJoinedByUser) {
    failures.push('user join mention for the second app was not posted');
  }
  if (!result.matched.appTwoJoinReplyObserved) {
    failures.push('second app did not reply after the user explicitly added it');
  }
  if (!result.matched.appTwoLateJoinHistoryObserved) {
    failures.push('second app did not prove it could see pre-join root history');
  }
  if (!result.matched.appTwoIgnoredMessagePosted) {
    failures.push('second app did not post the non-mention context message');
  }
  if (!result.matched.noAppOneReplyBeforeMentionObserved) {
    failures.push('first app replied before it was explicitly mentioned by the second app');
  }
  if (!result.matched.appTwoMentionMessagePosted) {
    failures.push('second app did not post the mention trigger');
  }
  if (!result.matched.appOneFinalReplyObserved) {
    failures.push('first app did not use the ignored context after the mention trigger');
  }

  if (failures.length > 0) {
    throw new Error(`Live dual-agent mention delta E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: DualAgentMentionDeltaResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'dual-agent-mention-delta-result.json',
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
  id: 'dual-agent-mention-delta',
  title: 'Dual Agent Mention Delta',
  description:
    'Start two Slack apps and verify the second app stays silent until the user explicitly mentions it, then joined bot-authored thread context is visible after a target mention.',
  keywords: ['dual-agent', 'mention', 'delta', 'thread', 'bot', 'app'],
  run: main,
};

runDirectly(scenario);
