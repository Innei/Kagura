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

interface A2AUserReplyRoutingResult {
  channelId: string;
  failureMessage?: string;
  leadBotUserId: string;
  matched: {
    leadReadyObserved: boolean;
    multiMentionLeadAssignmentObserved: boolean;
    multiMentionLeadSummaryObserved: boolean;
    multiMentionStandbyCompletionObserved: boolean;
    noMentionLeadObserved: boolean;
    ordinaryMessageSuppressed: boolean;
    singleMentionStandbyObserved: boolean;
  };
  passed: boolean;
  rootMessageTs?: string;
  runId: string;
  standbyBotUserId: string;
  teamMentionId: string;
  unexpected: string[];
}

const MULTI_CODEWORD = 'CEDAR';
const HISTORY_CODEWORD = 'MAPLE';

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the A2A reply-routing E2E.');
  }
  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error(
      'A2A reply-routing E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.',
    );
  }
  if (!env.SLACK_BOT_2_TOKEN || !env.SLACK_APP_2_TOKEN || !env.SLACK_SIGNING_2_SECRET) {
    throw new Error(
      'A2A reply-routing E2E requires SLACK_BOT_2_TOKEN, SLACK_APP_2_TOKEN, and SLACK_SIGNING_2_SECRET.',
    );
  }

  const runId = randomUUID();
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const appOneClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const appTwoClient = new SlackApiClient(env.SLACK_BOT_2_TOKEN);
  const appOneIdentity = await appOneClient.authTest();
  const appTwoIdentity = await appTwoClient.authTest();
  const teamMentionId =
    process.env.SLACK_E2E_AGENT_TEAM_ID?.trim() ||
    `S${runId.replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  const runSuffix = `a2a-routing-${runId.slice(0, 8)}`;
  const coordinatorDbPath = withPathSuffix(env.SESSION_DB_PATH, runSuffix);
  const appOneSessionDbPath = withPathSuffix(env.SESSION_DB_PATH, `${runSuffix}-app1`);
  const appTwoSessionDbPath = withPathSuffix(env.SESSION_DB_PATH, `${runSuffix}-app2`);
  applyLiveE2EDatabaseMigrations(appOneSessionDbPath);
  applyLiveE2EDatabaseMigrations(appTwoSessionDbPath);
  const agentTeams = {
    [teamMentionId]: {
      defaultLead: appOneIdentity.user_id,
      members: [appOneIdentity.user_id, appTwoIdentity.user_id],
      name: 'kagura-agents-e2e',
    },
  };

  const result: A2AUserReplyRoutingResult = {
    channelId: env.SLACK_E2E_CHANNEL_ID,
    leadBotUserId: appOneIdentity.user_id,
    matched: {
      leadReadyObserved: false,
      multiMentionLeadAssignmentObserved: false,
      multiMentionLeadSummaryObserved: false,
      multiMentionStandbyCompletionObserved: false,
      noMentionLeadObserved: false,
      ordinaryMessageSuppressed: false,
      singleMentionStandbyObserved: false,
    },
    passed: false,
    runId,
    standbyBotUserId: appTwoIdentity.user_id,
    teamMentionId,
    unexpected: [],
  };

  const appOne = createLiveApplication({
    a2aCoordinatorDbPath: coordinatorDbPath,
    agentTeams,
    executionProbePath: withPathSuffix(env.SLACK_E2E_EXECUTION_PROBE_PATH, `${runSuffix}-app1`),
    instanceLabel: 'bootstrap:a2a-routing-lead',
    sessionDbPath: appOneSessionDbPath,
    statusProbePath: withPathSuffix(env.SLACK_E2E_STATUS_PROBE_PATH, `${runSuffix}-app1`),
  });
  const appTwo = createLiveApplication({
    a2aCoordinatorDbPath: coordinatorDbPath,
    agentTeams,
    executionProbePath: withPathSuffix(env.SLACK_E2E_EXECUTION_PROBE_PATH, `${runSuffix}-app2`),
    instanceLabel: 'bootstrap:a2a-routing-standby',
    sessionDbPath: appTwoSessionDbPath,
    skipManifestSync: true,
    slackCredentials: {
      appToken: env.SLACK_APP_2_TOKEN,
      botToken: env.SLACK_BOT_2_TOKEN,
      signingSecret: env.SLACK_SIGNING_2_SECRET,
    },
    statusProbePath: withPathSuffix(env.SLACK_E2E_STATUS_PROBE_PATH, `${runSuffix}-app2`),
  });
  let caughtError: unknown;

  try {
    await appOne.start();
    await appTwo.start();
    await delay(3_000);

    const ordinaryMessage = await postMessageWithRetry(triggerClient, {
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: [
        `A2A_ORDINARY_IGNORED ${runId}`,
        `If a Kagura app incorrectly processes this ordinary channel message, it must reply exactly "A2A_ORDINARY_SHOULD_NOT_REPLY ${runId}".`,
      ].join('\n'),
      unfurl_links: false,
      unfurl_media: false,
    });
    await assertNoBotReply({
      botClient: appOneClient,
      botUserId: appOneIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: ordinaryMessage.ts,
      sinceTs: ordinaryMessage.ts,
      textIncludes: `A2A_ORDINARY_SHOULD_NOT_REPLY ${runId}`,
      unexpected: result.unexpected,
    });
    await assertNoBotReply({
      botClient: appTwoClient,
      botUserId: appTwoIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: ordinaryMessage.ts,
      sinceTs: ordinaryMessage.ts,
      textIncludes: `A2A_ORDINARY_SHOULD_NOT_REPLY ${runId}`,
      unexpected: result.unexpected,
    });
    result.matched.ordinaryMessageSuppressed = true;

    const rootMessage = await postMessageWithRetry(triggerClient, {
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: [
        `<!subteam^${teamMentionId}|@kagura-agents> A2A_USER_REPLY_ROUTING ${runId}`,
        'This is a Slack A2A routing test. Do not use tools.',
        `The shared history codeword for this thread is ${HISTORY_CODEWORD}.`,
        `The lead app <@${appOneIdentity.user_id}> must reply exactly "A2A_READY ${runId}".`,
        `When a later user reply contains "A2A_NO_MENTION ${runId}", the lead app <@${appOneIdentity.user_id}> must reply exactly "A2A_NO_MENTION_LEAD ${runId}".`,
        `When a later user reply mentions <@${appTwoIdentity.user_id}> and contains "A2A_SINGLE_MENTION ${runId}", the standby app <@${appTwoIdentity.user_id}> must reply exactly "A2A_SINGLE_STANDBY ${runId} ${HISTORY_CODEWORD}".`,
        `When a later user reply mentions both <@${appOneIdentity.user_id}> and <@${appTwoIdentity.user_id}> and contains "A2A_MULTI_MENTION ${runId}", the lead app <@${appOneIdentity.user_id}> must assign work by replying exactly "<@${appTwoIdentity.user_id}> A2A_MULTI_ASSIGN ${runId}".`,
        `When the standby app <@${appTwoIdentity.user_id}> receives "A2A_MULTI_ASSIGN ${runId}", it must reply exactly "A2A_MULTI_WORKER_DONE ${runId} ${MULTI_CODEWORD}".`,
        `When the host automatically wakes the lead for that multi-agent assignment summary, the lead app <@${appOneIdentity.user_id}> must reply exactly "A2A_MULTI_SUMMARY ${runId} ${MULTI_CODEWORD}".`,
      ].join('\n'),
      unfurl_links: false,
      unfurl_media: false,
    });
    result.rootMessageTs = rootMessage.ts;

    const leadReady = await waitForBotReply({
      botClient: appOneClient,
      botUserId: appOneIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: rootMessage.ts,
      textIncludes: `A2A_READY ${runId}`,
    });
    result.matched.leadReadyObserved = true;
    await waitForBothAppsToSettle(appOne, appTwo, rootMessage.ts);

    const noMentionPrompt = await postMessageWithRetry(triggerClient, {
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: `A2A_NO_MENTION ${runId}`,
      thread_ts: rootMessage.ts,
      unfurl_links: false,
      unfurl_media: false,
    });
    await waitForBotReply({
      botClient: appOneClient,
      botUserId: appOneIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: noMentionPrompt.ts,
      textIncludes: `A2A_NO_MENTION_LEAD ${runId}`,
    });
    result.matched.noMentionLeadObserved = true;
    await assertNoBotReply({
      botClient: appTwoClient,
      botUserId: appTwoIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: noMentionPrompt.ts,
      textIncludes: `A2A_NO_MENTION_LEAD ${runId}`,
      unexpected: result.unexpected,
    });
    await waitForBothAppsToSettle(appOne, appTwo, rootMessage.ts);

    const singleMentionPrompt = await postMessageWithRetry(triggerClient, {
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: `<@${appTwoIdentity.user_id}> A2A_SINGLE_MENTION ${runId}`,
      thread_ts: rootMessage.ts,
      unfurl_links: false,
      unfurl_media: false,
    });
    await waitForBotReply({
      botClient: appTwoClient,
      botUserId: appTwoIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: singleMentionPrompt.ts,
      textIncludes: `A2A_SINGLE_STANDBY ${runId} ${HISTORY_CODEWORD}`,
    });
    result.matched.singleMentionStandbyObserved = true;
    await assertNoBotReply({
      botClient: appOneClient,
      botUserId: appOneIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: singleMentionPrompt.ts,
      textIncludes: `A2A_SINGLE_STANDBY ${runId} ${HISTORY_CODEWORD}`,
      unexpected: result.unexpected,
    });
    await waitForBothAppsToSettle(appOne, appTwo, rootMessage.ts);

    const multiMentionPrompt = await postMessageWithRetry(triggerClient, {
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: `<@${appOneIdentity.user_id}> <@${appTwoIdentity.user_id}> A2A_MULTI_MENTION ${runId}`,
      thread_ts: rootMessage.ts,
      unfurl_links: false,
      unfurl_media: false,
    });
    const multiAssignment = await waitForBotReply({
      botClient: appOneClient,
      botUserId: appOneIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: multiMentionPrompt.ts,
      textIncludes: `A2A_MULTI_ASSIGN ${runId}`,
    });
    result.matched.multiMentionLeadAssignmentObserved = true;

    const multiWorkerDone = await waitForBotReply({
      botClient: appTwoClient,
      botUserId: appTwoIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: multiAssignment.ts,
      textIncludes: `A2A_MULTI_WORKER_DONE ${runId} ${MULTI_CODEWORD}`,
    });
    result.matched.multiMentionStandbyCompletionObserved = true;

    await waitForBotReplyMatching({
      botClient: appOneClient,
      botUserId: appOneIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: multiWorkerDone.ts,
      description: 'lead auto-summary after multi-agent worker completion',
      matches: (text) =>
        text.includes(`A2A_MULTI_SUMMARY ${runId} ${MULTI_CODEWORD}`) ||
        isLeadAutoSummaryText(text),
    });
    result.matched.multiMentionLeadSummaryObserved = true;

    await waitForBothAppsToSettle(appOne, appTwo, rootMessage.ts);
    await writeResult(result);
    assertResult(result);
    result.passed = true;
    await writeResult(result);
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error);
    caughtError = error;
  } finally {
    await writeResult(result).catch(() => {});
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
    const replies = await conversationRepliesWithRetry(input.botClient, input);
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

function isLeadAutoSummaryText(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes('routing') &&
    (normalized.includes('completed') ||
      normalized.includes('completion') ||
      normalized.includes('concluded') ||
      normalized.includes('summary')) &&
    (normalized.includes('multi') ||
      normalized.includes('delegat') ||
      normalized.includes('assignment') ||
      normalized.includes('worker'))
  );
}

async function waitForBotReplyMatching(input: {
  botClient: SlackApiClient;
  botUserId: string;
  channelId: string;
  description: string;
  matches: (text: string) => boolean;
  rootTs: string;
  sinceTs: string;
}): Promise<{ text: string; ts: string }> {
  const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const replies = await conversationRepliesWithRetry(input.botClient, input);
    for (const message of replies.messages ?? []) {
      if (!message.ts || Number(message.ts) <= Number(input.sinceTs)) {
        continue;
      }
      if (message.user !== input.botUserId) {
        continue;
      }
      const text = typeof message.text === 'string' ? message.text : '';
      if (input.matches(text)) {
        return { text, ts: message.ts };
      }
    }
    await delay(2_500);
  }
  throw new Error(`Timed out waiting for ${input.description}.`);
}

async function assertNoBotReply(input: {
  botClient: SlackApiClient;
  botUserId: string;
  channelId: string;
  rootTs: string;
  sinceTs: string;
  textIncludes: string;
  unexpected: string[];
}): Promise<void> {
  await delay(2_500);
  const replies = await conversationRepliesWithRetry(input.botClient, input);
  const match = findBotMessageAfterTs(replies, input.botUserId, input.sinceTs, input.textIncludes);
  if (match) {
    input.unexpected.push(
      `Unexpected <@${input.botUserId}> reply containing "${input.textIncludes}" at ${match.ts}`,
    );
  }
}

async function postMessageWithRetry(
  client: SlackApiClient,
  args: Parameters<SlackApiClient['postMessage']>[0],
): ReturnType<SlackApiClient['postMessage']> {
  return retrySlackApi(() => client.postMessage(args));
}

async function conversationRepliesWithRetry(
  client: SlackApiClient,
  input: { channelId: string; rootTs: string },
): Promise<SlackConversationRepliesResponse> {
  return retrySlackApi(() =>
    client.conversationReplies({
      channel: input.channelId,
      inclusive: true,
      limit: 100,
      ts: input.rootTs,
    }),
  );
}

async function retrySlackApi<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === 5) {
        break;
      }
      await delay(1_000 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function findBotMessageAfterTs(
  replies: SlackConversationRepliesResponse,
  botUserId: string,
  sinceTs: string,
  textIncludes: string,
): { text: string; ts: string } | undefined {
  for (const message of replies.messages ?? []) {
    if (!message.ts || Number(message.ts) <= Number(sinceTs) || message.user !== botUserId) {
      continue;
    }
    const text = typeof message.text === 'string' ? message.text : '';
    if (text.includes(textIncludes)) {
      return { text, ts: message.ts };
    }
  }
  return undefined;
}

function assertResult(result: A2AUserReplyRoutingResult): void {
  const failures: string[] = [];
  if (!result.matched.leadReadyObserved) failures.push('lead ready reply was not observed');
  if (!result.matched.noMentionLeadObserved) {
    failures.push('lead reply for no-mention user message was not observed');
  }
  if (!result.matched.ordinaryMessageSuppressed) {
    failures.push('ordinary channel message was not verified as suppressed');
  }
  if (!result.matched.singleMentionStandbyObserved) {
    failures.push('standby reply for single-agent mention with prior history was not observed');
  }
  if (!result.matched.multiMentionLeadAssignmentObserved) {
    failures.push('lead assignment for multi-agent mention was not observed');
  }
  if (!result.matched.multiMentionStandbyCompletionObserved) {
    failures.push('standby completion for multi-agent lead assignment was not observed');
  }
  if (!result.matched.multiMentionLeadSummaryObserved) {
    failures.push('lead summary after multi-agent assignment was not observed');
  }
  failures.push(...result.unexpected);
  if (failures.length > 0) {
    throw new Error(`A2A user reply-routing E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: A2AUserReplyRoutingResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'dual-agent-a2a-user-reply-routing-result.json',
  );
  const absolutePath = path.resolve(process.cwd(), resultPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

function withPathSuffix(rawPath: string, suffix: string): string {
  const parsed = path.parse(rawPath);
  return path.join(parsed.dir, `${parsed.name}-${suffix}${parsed.ext}`);
}

async function waitForBothAppsToSettle(
  appOne: ReturnType<typeof createLiveApplication>,
  appTwo: ReturnType<typeof createLiveApplication>,
  threadTs: string,
): Promise<void> {
  await Promise.all([
    waitForThreadExecutionsToSettle(appOne.threadExecutionRegistry, threadTs),
    waitForThreadExecutionsToSettle(appTwo.threadExecutionRegistry, threadTs),
  ]);
}

async function waitForThreadExecutionsToSettle(
  registry: ReturnType<typeof createLiveApplication>['threadExecutionRegistry'],
  threadTs: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (registry.listActive(threadTs).length === 0) {
      await delay(2_500);
      return;
    }
    await delay(1_000);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export const scenario: LiveE2EScenario = {
  id: 'dual-agent-a2a-user-reply-routing',
  title: 'Dual Agent A2A User Reply Routing',
  description:
    'Verify A2A routing for user thread replies with no explicit agent mention, one explicit agent mention, and multiple explicit agent mentions that lead to assignment and summary.',
  keywords: [
    'dual-agent',
    'a2a',
    'routing',
    'lead',
    'standby',
    'user-reply',
    'thread',
    'assignment',
    'summary',
  ],
  run: main,
};

runDirectly(scenario);
