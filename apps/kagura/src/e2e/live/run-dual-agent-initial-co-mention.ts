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

interface DualAgentInitialCoMentionResult {
  appOneBotUserId: string;
  appTwoBotUserId: string;
  channelId: string;
  failureMessage?: string;
  leadBotUserId: string;
  leadFinalText?: string;
  leadFinalTs?: string;
  leadHandoffText?: string;
  leadHandoffTs?: string;
  matched: {
    leadFinalObserved: boolean;
    leadHandoffObserved: boolean;
    standbyInitialSuppressed: boolean;
    standbyResponseObserved: boolean;
  };
  passed: boolean;
  rootMessageTs?: string;
  runId: string;
  standbyBotUserId: string;
  standbyInitialText?: string;
  standbyInitialTs?: string;
  standbyResponseText?: string;
  standbyResponseTs?: string;
  teamMentionId: string;
}

const CO_CODEWORD = 'VIOLET';

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the dual-agent E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error(
      'Dual-agent initial co-mention E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.',
    );
  }

  if (!env.SLACK_BOT_2_TOKEN || !env.SLACK_APP_2_TOKEN || !env.SLACK_SIGNING_2_SECRET) {
    throw new Error(
      'Dual-agent initial co-mention E2E requires SLACK_BOT_2_TOKEN, SLACK_APP_2_TOKEN, and SLACK_SIGNING_2_SECRET.',
    );
  }

  const runId = randomUUID();
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const appOneClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const appTwoClient = new SlackApiClient(env.SLACK_BOT_2_TOKEN);
  const appOneIdentity = await appOneClient.authTest();
  const appTwoIdentity = await appTwoClient.authTest();
  const coordinatorDbPath = withPathSuffix(
    env.A2A_COORDINATOR_DB_PATH,
    `team-${runId.slice(0, 8)}`,
  );
  const appTwoSessionDbPath = withPathSuffix(env.SESSION_DB_PATH, 'app2');
  applyLiveE2EDatabaseMigrations(appTwoSessionDbPath);
  const leadApp = resolveLeadApp();
  const lead =
    leadApp === 'app2'
      ? { client: appTwoClient, identity: appTwoIdentity, label: 'app two' }
      : { client: appOneClient, identity: appOneIdentity, label: 'app one' };
  const standby =
    leadApp === 'app2'
      ? { client: appOneClient, identity: appOneIdentity, label: 'app one' }
      : { client: appTwoClient, identity: appTwoIdentity, label: 'app two' };
  const teamMentionId =
    process.env.SLACK_E2E_AGENT_TEAM_ID?.trim() ||
    `S${runId.replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  const agentTeams = {
    [teamMentionId]: {
      defaultLead: lead.identity.user_id,
      members: [appOneIdentity.user_id, appTwoIdentity.user_id],
      name: 'kagura-agents-e2e',
    },
  };

  const result: DualAgentInitialCoMentionResult = {
    appOneBotUserId: appOneIdentity.user_id,
    appTwoBotUserId: appTwoIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    leadBotUserId: lead.identity.user_id,
    matched: {
      leadFinalObserved: false,
      leadHandoffObserved: false,
      standbyInitialSuppressed: false,
      standbyResponseObserved: false,
    },
    passed: false,
    runId,
    standbyBotUserId: standby.identity.user_id,
    teamMentionId,
  };

  const appOne = createLiveApplication({
    a2aCoordinatorDbPath: coordinatorDbPath,
    agentTeams,
    instanceLabel: 'bootstrap:app1',
  });
  const appTwo = createLiveApplication({
    a2aCoordinatorDbPath: coordinatorDbPath,
    agentTeams,
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
      `<!subteam^${teamMentionId}|@kagura-agents> DUAL_AGENT_TEAM_MENTION ${runId}`,
      'This is a Slack routing test. Do not use code, file, memory, or interactive question tools.',
      `The host injects your current Slack app identity. If this initial root message starts the lead app <@${lead.identity.user_id}>, the lead app must reply exactly "<@${standby.identity.user_id}> DUAL_AGENT_TEAM_REQUEST ${runId}".`,
      `If this initial root message starts the standby app <@${standby.identity.user_id}>, the standby app must reply exactly "DUAL_AGENT_TEAM_STANDBY_INITIAL ${runId}".`,
      `When the standby app receives DUAL_AGENT_TEAM_REQUEST ${runId}, the standby app must reply exactly "<@${lead.identity.user_id}> DUAL_AGENT_TEAM_RESPONSE ${runId} ${CO_CODEWORD}".`,
      `When the lead app receives DUAL_AGENT_TEAM_RESPONSE ${runId} ${CO_CODEWORD}, the lead app must reply exactly "DUAL_AGENT_TEAM_FINAL ${runId} ${CO_CODEWORD}".`,
    ].join('\n');

    const rootMessage = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: rootPrompt,
      unfurl_links: false,
      unfurl_media: false,
    });
    result.rootMessageTs = rootMessage.ts;
    console.info('Posted dual-agent team mention root message: %s', rootMessage.ts);

    const leadHandoff = await waitForBotReply({
      botClient: lead.client,
      botUserId: lead.identity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: rootMessage.ts,
      textIncludes: `DUAL_AGENT_TEAM_REQUEST ${runId}`,
    });
    result.leadHandoffText = leadHandoff.text;
    result.leadHandoffTs = leadHandoff.ts;
    result.matched.leadHandoffObserved = true;
    console.info('Observed %s handoff to standby: %s', lead.label, leadHandoff.ts);

    const standbyInitial = await findBotReply({
      botClient: standby.client,
      botUserId: standby.identity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: rootMessage.ts,
      textIncludes: `DUAL_AGENT_TEAM_STANDBY_INITIAL ${runId}`,
    });
    if (standbyInitial) {
      result.standbyInitialText = standbyInitial.text;
      result.standbyInitialTs = standbyInitial.ts;
    } else {
      result.matched.standbyInitialSuppressed = true;
    }

    const standbyResponse = await waitForBotReply({
      botClient: standby.client,
      botUserId: standby.identity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: leadHandoff.ts,
      textIncludes: `DUAL_AGENT_TEAM_RESPONSE ${runId} ${CO_CODEWORD}`,
    });
    result.standbyResponseText = standbyResponse.text;
    result.standbyResponseTs = standbyResponse.ts;
    result.matched.standbyResponseObserved = true;
    console.info('Observed %s response to lead: %s', standby.label, standbyResponse.ts);

    const leadFinal = await waitForBotReply({
      botClient: lead.client,
      botUserId: lead.identity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: standbyResponse.ts,
      textIncludes: `DUAL_AGENT_TEAM_FINAL ${runId} ${CO_CODEWORD}`,
    });
    result.leadFinalText = leadFinal.text;
    result.leadFinalTs = leadFinal.ts;
    result.matched.leadFinalObserved = true;
    console.info('Observed %s final team reply: %s', lead.label, leadFinal.ts);

    await Promise.all([
      waitForThreadExecutionsToSettle(appOne.threadExecutionRegistry, rootMessage.ts),
      waitForThreadExecutionsToSettle(appTwo.threadExecutionRegistry, rootMessage.ts),
    ]);

    await writeResult(result);
    assertResult(result);
    result.passed = true;
    await writeResult(result);

    console.info('Live dual-agent initial co-mention E2E passed.');
    console.info('Root thread: %s', result.rootMessageTs);
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error);
    caughtError = error;
  } finally {
    await writeResult(result).catch((error) => {
      console.error('Failed to persist dual-agent initial co-mention result:', error);
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
    limit: 100,
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

function withPathSuffix(rawPath: string, suffix: string): string {
  const parsed = path.parse(rawPath);
  return path.join(parsed.dir, `${parsed.name}-${suffix}${parsed.ext}`);
}

function resolveLeadApp(): 'app1' | 'app2' {
  const raw = process.env.SLACK_E2E_AGENT_TEAM_LEAD?.trim().toLowerCase();
  if (raw === 'app2') {
    return 'app2';
  }
  return 'app1';
}

async function waitForThreadExecutionsToSettle(
  registry: ReturnType<typeof createLiveApplication>['threadExecutionRegistry'],
  threadTs: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (registry.listActive(threadTs).length === 0) {
      return;
    }
    await delay(1_000);
  }
}

function assertResult(result: DualAgentInitialCoMentionResult): void {
  const failures: string[] = [];

  if (!result.matched.leadHandoffObserved) {
    failures.push('team lead did not mention the standby app from the initial team mention');
  }
  if (!result.matched.standbyInitialSuppressed) {
    failures.push('standby app replied to the initial team mention instead of staying standby');
  }
  if (!result.matched.standbyResponseObserved) {
    failures.push('standby app did not respond to the lead app mention');
  }
  if (!result.matched.leadFinalObserved) {
    failures.push('lead app did not respond to the standby app mention');
  }

  if (failures.length > 0) {
    throw new Error(`Live dual-agent initial co-mention E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: DualAgentInitialCoMentionResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'dual-agent-initial-co-mention-result.json',
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
  id: 'dual-agent-initial-co-mention',
  title: 'Dual Agent Initial Team Mention',
  description:
    'Start two Slack apps from a root Slack user-group mention, then verify only the lead starts and the standby app joins after a direct mention.',
  keywords: ['dual-agent', 'mention', 'co-mention', 'team', 'subteam', 'thread', 'bot', 'app'],
  run: main,
};

runDirectly(scenario);
