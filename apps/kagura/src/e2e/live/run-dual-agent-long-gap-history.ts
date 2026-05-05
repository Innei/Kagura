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

interface DualAgentLongGapHistoryResult {
  appOneBotUserId: string;
  appOneFinalText?: string;
  appOneFinalTs?: string;
  appOneHandoffText?: string;
  appOneHandoffTs?: string;
  appOneReadyText?: string;
  appOneReadyTs?: string;
  appTwoBotUserId: string;
  appTwoInitialText?: string;
  appTwoInitialTs?: string;
  appTwoResponseText?: string;
  appTwoResponseTs?: string;
  channelId: string;
  failureMessage?: string;
  fillerAckTexts: string[];
  fillerAckTs: string[];
  fillerPromptTs: string[];
  handoffPromptTs?: string;
  matched: {
    appOneFinalObserved: boolean;
    appOneHandoffObserved: boolean;
    appOneReadyObserved: boolean;
    appTwoInitialSuppressed: boolean;
    appTwoLongGapHistoryObserved: boolean;
    fillerAcksObserved: boolean;
    userHandoffPromptPosted: boolean;
  };
  passed: boolean;
  rootMessageTs?: string;
  runId: string;
}

const GAP_CODEWORD = 'MAGNOLIA';
const GAP_STEP_COUNT = 4;

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the dual-agent E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error(
      'Dual-agent long-gap history E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.',
    );
  }

  if (!env.SLACK_BOT_2_TOKEN || !env.SLACK_APP_2_TOKEN || !env.SLACK_SIGNING_2_SECRET) {
    throw new Error(
      'Dual-agent long-gap history E2E requires SLACK_BOT_2_TOKEN, SLACK_APP_2_TOKEN, and SLACK_SIGNING_2_SECRET.',
    );
  }

  const runId = randomUUID();
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const appOneClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const appTwoClient = new SlackApiClient(env.SLACK_BOT_2_TOKEN);
  const appOneIdentity = await appOneClient.authTest();
  const appTwoIdentity = await appTwoClient.authTest();
  const coordinatorDbPath = withPathSuffix(env.A2A_COORDINATOR_DB_PATH, `gap-${runId.slice(0, 8)}`);
  const appTwoSessionDbPath = withPathSuffix(env.SESSION_DB_PATH, 'app2');
  applyLiveE2EDatabaseMigrations(appTwoSessionDbPath);

  const result: DualAgentLongGapHistoryResult = {
    appOneBotUserId: appOneIdentity.user_id,
    appTwoBotUserId: appTwoIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    fillerAckTexts: [],
    fillerAckTs: [],
    fillerPromptTs: [],
    matched: {
      appOneFinalObserved: false,
      appOneHandoffObserved: false,
      appOneReadyObserved: false,
      appTwoInitialSuppressed: false,
      appTwoLongGapHistoryObserved: false,
      fillerAcksObserved: false,
      userHandoffPromptPosted: false,
    },
    passed: false,
    runId,
  };

  const appOne = createLiveApplication({
    a2aCoordinatorDbPath: coordinatorDbPath,
    instanceLabel: 'bootstrap:app1',
  });
  const appTwo = createLiveApplication({
    a2aCoordinatorDbPath: coordinatorDbPath,
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

    const ackMarkers = Array.from({ length: GAP_STEP_COUNT }, (_, index) => {
      const step = index + 1;
      return `DUAL_AGENT_GAP_ACK_${step} ${runId}`;
    });

    const rootPrompt = [
      `<@${appOneIdentity.user_id}> <@${appTwoIdentity.user_id}> DUAL_AGENT_LONG_GAP ${runId}`,
      'This is a Slack routing test. Do not use code, file, memory, or interactive question tools.',
      `Early history marker: DUAL_AGENT_EARLY_CONTEXT ${runId} codeword ${GAP_CODEWORD}.`,
      `The host injects your current Slack app identity. If your identity is <@${appOneIdentity.user_id}>, reply exactly "DUAL_AGENT_GAP_APP1_READY ${runId}".`,
      `If your identity is <@${appTwoIdentity.user_id}>, do not reply to this initial co-mention; app two is standby until directly mentioned later.`,
      `Later, when app one receives DUAL_AGENT_GAP_HANDOFF ${runId}, app one must reply exactly "<@${appTwoIdentity.user_id}> DUAL_AGENT_GAP_REQUEST ${runId}".`,
      `Later, when app two receives DUAL_AGENT_GAP_REQUEST ${runId}, app two must inspect this Slack thread history. If it can see DUAL_AGENT_EARLY_CONTEXT ${runId}, ${GAP_CODEWORD}, and all of these gap acknowledgements: ${ackMarkers.join(', ')}, app two must reply exactly "<@${appOneIdentity.user_id}> DUAL_AGENT_GAP_RESPONSE ${runId} ${GAP_CODEWORD} ACKS_OK".`,
      `Later, when app one receives DUAL_AGENT_GAP_RESPONSE ${runId} ${GAP_CODEWORD} ACKS_OK, app one must reply exactly "DUAL_AGENT_GAP_FINAL ${runId} ${GAP_CODEWORD} ACKS_OK".`,
    ].join(' ');

    const rootMessage = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: rootPrompt,
      unfurl_links: false,
      unfurl_media: false,
    });
    result.rootMessageTs = rootMessage.ts;
    console.info('Posted dual-agent long-gap root message: %s', rootMessage.ts);

    const appOneReady = await waitForBotReply({
      botClient: appOneClient,
      botUserId: appOneIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: rootMessage.ts,
      textIncludes: `DUAL_AGENT_GAP_APP1_READY ${runId}`,
    });
    result.appOneReadyText = appOneReady.text;
    result.appOneReadyTs = appOneReady.ts;
    result.matched.appOneReadyObserved = true;
    console.info('Observed app one long-gap ready reply: %s', appOneReady.ts);

    const appTwoInitial = await findBotReply({
      botClient: appTwoClient,
      botUserId: appTwoIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: rootMessage.ts,
      textIncludes: `DUAL_AGENT_GAP_APP2_READY ${runId}`,
    });
    if (appTwoInitial) {
      result.appTwoInitialText = appTwoInitial.text;
      result.appTwoInitialTs = appTwoInitial.ts;
    } else {
      result.matched.appTwoInitialSuppressed = true;
    }

    let sinceTs = appOneReady.ts;
    for (let step = 1; step <= GAP_STEP_COUNT; step += 1) {
      const stepPrompt = await triggerClient.postMessage({
        channel: env.SLACK_E2E_CHANNEL_ID,
        text: [
          `<@${appOneIdentity.user_id}> DUAL_AGENT_GAP_STEP_${step} ${runId}`,
          `This is filler conversation ${step} of ${GAP_STEP_COUNT}.`,
          `Reply exactly "DUAL_AGENT_GAP_ACK_${step} ${runId}".`,
        ].join(' '),
        thread_ts: rootMessage.ts,
        unfurl_links: false,
        unfurl_media: false,
      });
      result.fillerPromptTs.push(stepPrompt.ts);
      console.info('Posted long-gap filler prompt %d: %s', step, stepPrompt.ts);

      const ack = await waitForBotReply({
        botClient: appOneClient,
        botUserId: appOneIdentity.user_id,
        channelId: env.SLACK_E2E_CHANNEL_ID,
        rootTs: rootMessage.ts,
        sinceTs: maxSlackTs(sinceTs, stepPrompt.ts),
        textIncludes: `DUAL_AGENT_GAP_ACK_${step} ${runId}`,
      });
      result.fillerAckTexts.push(ack.text);
      result.fillerAckTs.push(ack.ts);
      console.info('Observed long-gap filler ack %d: %s', step, ack.ts);
      sinceTs = ack.ts;
    }
    result.matched.fillerAcksObserved = result.fillerAckTs.length === GAP_STEP_COUNT;

    const handoffPrompt = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: [
        `<@${appOneIdentity.user_id}> DUAL_AGENT_GAP_HANDOFF ${runId}`,
        'Now mention the second app using the exact handoff from the root instructions.',
      ].join(' '),
      thread_ts: rootMessage.ts,
      unfurl_links: false,
      unfurl_media: false,
    });
    result.handoffPromptTs = handoffPrompt.ts;
    result.matched.userHandoffPromptPosted = true;
    console.info('Posted long-gap handoff prompt to app one: %s', handoffPrompt.ts);

    const appOneHandoff = await waitForBotReply({
      botClient: appOneClient,
      botUserId: appOneIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: handoffPrompt.ts,
      textIncludes: `DUAL_AGENT_GAP_REQUEST ${runId}`,
    });
    result.appOneHandoffText = appOneHandoff.text;
    result.appOneHandoffTs = appOneHandoff.ts;
    result.matched.appOneHandoffObserved = true;
    console.info('Observed long-gap app one handoff: %s', appOneHandoff.ts);

    const appTwoResponse = await waitForBotReply({
      botClient: appTwoClient,
      botUserId: appTwoIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: appOneHandoff.ts,
      textIncludes: `DUAL_AGENT_GAP_RESPONSE ${runId} ${GAP_CODEWORD} ACKS_OK`,
    });
    result.appTwoResponseText = appTwoResponse.text;
    result.appTwoResponseTs = appTwoResponse.ts;
    result.matched.appTwoLongGapHistoryObserved = true;
    console.info('Observed long-gap app two history response: %s', appTwoResponse.ts);

    const appOneFinal = await waitForBotReply({
      botClient: appOneClient,
      botUserId: appOneIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: appTwoResponse.ts,
      textIncludes: `DUAL_AGENT_GAP_FINAL ${runId} ${GAP_CODEWORD} ACKS_OK`,
    });
    result.appOneFinalText = appOneFinal.text;
    result.appOneFinalTs = appOneFinal.ts;
    result.matched.appOneFinalObserved = true;
    console.info('Observed long-gap app one final reply: %s', appOneFinal.ts);

    await writeResult(result);
    assertResult(result);
    result.passed = true;
    await writeResult(result);

    console.info('Live dual-agent long-gap history E2E passed.');
    console.info('Root thread: %s', result.rootMessageTs);
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error);
    caughtError = error;
  } finally {
    await writeResult(result).catch((error) => {
      console.error('Failed to persist dual-agent long-gap history result:', error);
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
      limit: 160,
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

async function findBotReply(input: {
  botClient: SlackApiClient;
  botUserId: string;
  channelId: string;
  rootTs: string;
  sinceTs: string;
  textIncludes: string;
}): Promise<{ text: string; ts: string } | undefined> {
  const replies = await input.botClient.conversationReplies({
    channel: input.channelId,
    inclusive: true,
    limit: 160,
    ts: input.rootTs,
  });

  return findBotMessageAfterTs(replies, input.botUserId, input.sinceTs, input.textIncludes);
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
    if (message.user !== botUserId) {
      continue;
    }
    const text = typeof message.text === 'string' ? message.text : '';
    if (text.includes(textIncludes)) {
      return { text, ts: message.ts };
    }
  }
  return undefined;
}

function isTsAfter(candidate: string, reference: string): boolean {
  return Number(candidate) > Number(reference);
}

function maxSlackTs(a: string, b: string): string {
  return Number(a) >= Number(b) ? a : b;
}

function withPathSuffix(rawPath: string, suffix: string): string {
  const parsed = path.parse(rawPath);
  return path.join(parsed.dir, `${parsed.name}-${suffix}${parsed.ext}`);
}

function assertResult(result: DualAgentLongGapHistoryResult): void {
  const failures: string[] = [];

  if (!result.matched.appOneReadyObserved) {
    failures.push('first app did not reply to the initial long-gap co-mention');
  }
  if (!result.matched.appTwoInitialSuppressed) {
    failures.push(
      'second app replied to the initial long-gap co-mention instead of staying standby',
    );
  }
  if (!result.matched.fillerAcksObserved) {
    failures.push(`first app did not complete all ${GAP_STEP_COUNT} filler acknowledgements`);
  }
  if (!result.matched.userHandoffPromptPosted) {
    failures.push('user handoff prompt to the first app was not posted');
  }
  if (!result.matched.appOneHandoffObserved) {
    failures.push('first app did not mention the second app after the long gap');
  }
  if (!result.matched.appTwoLongGapHistoryObserved) {
    failures.push('second app did not prove it could see early and long-gap thread history');
  }
  if (!result.matched.appOneFinalObserved) {
    failures.push('first app did not process the second app response after the long gap');
  }

  if (failures.length > 0) {
    throw new Error(`Live dual-agent long-gap history E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: DualAgentLongGapHistoryResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'dual-agent-long-gap-history-result.json',
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
  id: 'dual-agent-long-gap-history',
  title: 'Dual Agent Long-Gap History',
  description:
    'Start two Slack apps, run several intervening turns, then verify a later agent-to-agent mention can still use early and intervening thread history.',
  keywords: ['dual-agent', 'mention', 'history', 'long-gap', 'thread', 'bot', 'app'],
  run: main,
};

runDirectly(scenario);
