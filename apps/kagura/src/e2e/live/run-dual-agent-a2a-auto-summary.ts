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

interface A2AAutoSummaryResult {
  channelId: string;
  failureMessage?: string;
  leadBotUserId: string;
  matched: {
    leadAssignmentObserved: boolean;
    leadAutoSummaryObserved: boolean;
    standbyResponseObserved: boolean;
  };
  passed: boolean;
  rootMessageTs?: string;
  runId: string;
  standbyBotUserId: string;
  teamMentionId: string;
}

const CODEWORD = 'ORCHID';

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the A2A auto-summary E2E.');
  }
  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error(
      'A2A auto-summary E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.',
    );
  }
  if (!env.SLACK_BOT_2_TOKEN || !env.SLACK_APP_2_TOKEN || !env.SLACK_SIGNING_2_SECRET) {
    throw new Error(
      'A2A auto-summary E2E requires SLACK_BOT_2_TOKEN, SLACK_APP_2_TOKEN, and SLACK_SIGNING_2_SECRET.',
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
  const coordinatorDbPath = withPathSuffix(env.SESSION_DB_PATH, `a2a-${runId.slice(0, 8)}`);
  const appTwoSessionDbPath = withPathSuffix(env.SESSION_DB_PATH, 'a2a-app2');
  applyLiveE2EDatabaseMigrations(appTwoSessionDbPath);
  const agentTeams = {
    [teamMentionId]: {
      defaultLead: appOneIdentity.user_id,
      members: [appOneIdentity.user_id, appTwoIdentity.user_id],
      name: 'kagura-agents-e2e',
    },
  };

  const result: A2AAutoSummaryResult = {
    channelId: env.SLACK_E2E_CHANNEL_ID,
    leadBotUserId: appOneIdentity.user_id,
    matched: {
      leadAssignmentObserved: false,
      leadAutoSummaryObserved: false,
      standbyResponseObserved: false,
    },
    passed: false,
    runId,
    standbyBotUserId: appTwoIdentity.user_id,
    teamMentionId,
  };

  const appOne = createLiveApplication({
    a2aCoordinatorDbPath: coordinatorDbPath,
    agentTeams,
    instanceLabel: 'bootstrap:a2a-lead',
  });
  const appTwo = createLiveApplication({
    a2aCoordinatorDbPath: coordinatorDbPath,
    agentTeams,
    executionProbePath: withPathSuffix(env.SLACK_E2E_EXECUTION_PROBE_PATH, 'a2a-app2'),
    instanceLabel: 'bootstrap:a2a-standby',
    sessionDbPath: appTwoSessionDbPath,
    skipManifestSync: true,
    slackCredentials: {
      appToken: env.SLACK_APP_2_TOKEN,
      botToken: env.SLACK_BOT_2_TOKEN,
      signingSecret: env.SLACK_SIGNING_2_SECRET,
    },
    statusProbePath: withPathSuffix(env.SLACK_E2E_STATUS_PROBE_PATH, 'a2a-app2'),
  });
  let caughtError: unknown;

  try {
    await appOne.start();
    await appTwo.start();
    await delay(3_000);

    const rootMessage = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: [
        `<!subteam^${teamMentionId}|@kagura-agents> A2A_AUTO_SUMMARY ${runId}`,
        'This is a Slack A2A host test. Do not use tools.',
        `The lead app <@${appOneIdentity.user_id}> must first reply exactly "<@${appTwoIdentity.user_id}> A2A_ASSIGN ${runId}".`,
        `When the standby app <@${appTwoIdentity.user_id}> receives A2A_ASSIGN ${runId}, it must reply exactly "A2A_WORKER_DONE ${runId} ${CODEWORD}" and must not mention the lead app.`,
        `When the host automatically wakes the lead for the final summary, the lead must reply exactly "A2A_LEAD_SUMMARY ${runId} ${CODEWORD}".`,
      ].join('\n'),
      unfurl_links: false,
      unfurl_media: false,
    });
    result.rootMessageTs = rootMessage.ts;

    const leadAssignment = await waitForBotReply({
      botClient: appOneClient,
      botUserId: appOneIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: rootMessage.ts,
      textIncludes: `A2A_ASSIGN ${runId}`,
    });
    result.matched.leadAssignmentObserved = true;

    await waitForBotReply({
      botClient: appTwoClient,
      botUserId: appTwoIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: leadAssignment.ts,
      textIncludes: `A2A_WORKER_DONE ${runId} ${CODEWORD}`,
    });
    result.matched.standbyResponseObserved = true;

    await waitForBotReply({
      botClient: appOneClient,
      botUserId: appOneIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: leadAssignment.ts,
      textIncludes: `A2A_LEAD_SUMMARY ${runId} ${CODEWORD}`,
    });
    result.matched.leadAutoSummaryObserved = true;

    await Promise.all([
      waitForThreadExecutionsToSettle(appOne.threadExecutionRegistry, rootMessage.ts),
      waitForThreadExecutionsToSettle(appTwo.threadExecutionRegistry, rootMessage.ts),
    ]);

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
    const replies = await input.botClient.conversationReplies({
      channel: input.channelId,
      inclusive: true,
      limit: 100,
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

function assertResult(result: A2AAutoSummaryResult): void {
  const failures: string[] = [];
  if (!result.matched.leadAssignmentObserved) failures.push('lead assignment was not observed');
  if (!result.matched.standbyResponseObserved) failures.push('standby response was not observed');
  if (!result.matched.leadAutoSummaryObserved) failures.push('lead auto-summary was not observed');
  if (failures.length > 0) {
    throw new Error(`A2A auto-summary E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: A2AAutoSummaryResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'dual-agent-a2a-auto-summary-result.json',
  );
  const absolutePath = path.resolve(process.cwd(), resultPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

function withPathSuffix(rawPath: string, suffix: string): string {
  const parsed = path.parse(rawPath);
  return path.join(parsed.dir, `${parsed.name}-${suffix}${parsed.ext}`);
}

async function waitForThreadExecutionsToSettle(
  registry: ReturnType<typeof createLiveApplication>['threadExecutionRegistry'],
  threadTs: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (registry.listActive(threadTs).length === 0) {
      await delay(5_000);
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
  id: 'dual-agent-a2a-auto-summary',
  title: 'Dual Agent A2A Auto Summary',
  description:
    'Verify that a lead A2A assignment wakes a standby app and automatically returns to the lead after the standby execution reaches a terminal state.',
  keywords: ['dual-agent', 'a2a', 'summary', 'lead', 'standby', 'assignment', 'thread'],
  run: main,
};

runDirectly(scenario);
