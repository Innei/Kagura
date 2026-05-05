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

interface A2ARoleHandoffResult {
  channelId: string;
  diagnosticsDir: string;
  failureMessage?: string;
  leadBotUserId: string;
  matched: {
    diagnosticsCapturedQuietFinal: boolean;
    quietFinalObserved: boolean;
    roleBasedLeadHandoffObserved: boolean;
    standbyRoleReplyObserved: boolean;
  };
  passed: boolean;
  rootMessageTs?: string;
  runId: string;
  standbyBotUserId: string;
  teamMentionId: string;
}

const STANDBY_REPLY_CODEWORD = 'ROLE_OK';

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the A2A role-handoff E2E.');
  }
  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error(
      'A2A role-handoff E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.',
    );
  }
  if (!env.SLACK_BOT_2_TOKEN || !env.SLACK_APP_2_TOKEN || !env.SLACK_SIGNING_2_SECRET) {
    throw new Error(
      'A2A role-handoff E2E requires SLACK_BOT_2_TOKEN, SLACK_APP_2_TOKEN, and SLACK_SIGNING_2_SECRET.',
    );
  }

  const runId = randomUUID();
  const roleMarker = `A2A_ROLE_REVIEWER_${runId}`;
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const appOneClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const appTwoClient = new SlackApiClient(env.SLACK_BOT_2_TOKEN);
  const appOneIdentity = await appOneClient.authTest();
  const appTwoIdentity = await appTwoClient.authTest();
  const teamMentionId =
    process.env.SLACK_E2E_AGENT_TEAM_ID?.trim() ||
    `S${runId.replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  const runSuffix = `a2a-role-${runId.slice(0, 8)}`;
  const coordinatorDbPath = withPathSuffix(env.SESSION_DB_PATH, runSuffix);
  const appOneSessionDbPath = withPathSuffix(env.SESSION_DB_PATH, `${runSuffix}-app1`);
  const appTwoSessionDbPath = withPathSuffix(env.SESSION_DB_PATH, `${runSuffix}-app2`);
  applyLiveE2EDatabaseMigrations(appOneSessionDbPath);
  applyLiveE2EDatabaseMigrations(appTwoSessionDbPath);
  const diagnosticsDir = path.join(
    path.dirname(env.SLACK_E2E_RESULT_PATH),
    `${runSuffix}-diagnostics`,
  );
  await fs.rm(path.resolve(process.cwd(), diagnosticsDir), { force: true, recursive: true });

  const agentTeams = {
    [teamMentionId]: {
      defaultLead: appOneIdentity.user_id,
      members: [
        {
          id: appOneIdentity.user_id,
          label: 'lead-agent',
          role: 'lead coordination and final summary',
        },
        {
          id: appTwoIdentity.user_id,
          label: 'role-reviewer',
          role: `design review and critique role ${roleMarker}`,
        },
      ],
      name: 'kagura-agents-e2e',
    },
  };

  const result: A2ARoleHandoffResult = {
    channelId: env.SLACK_E2E_CHANNEL_ID,
    diagnosticsDir,
    leadBotUserId: appOneIdentity.user_id,
    matched: {
      diagnosticsCapturedQuietFinal: false,
      quietFinalObserved: false,
      roleBasedLeadHandoffObserved: false,
      standbyRoleReplyObserved: false,
    },
    passed: false,
    runId,
    standbyBotUserId: appTwoIdentity.user_id,
    teamMentionId,
  };

  const appOne = createLiveApplication({
    a2aCoordinatorDbPath: coordinatorDbPath,
    a2aDiagnosticsDir: diagnosticsDir,
    a2aOutputMode: 'quiet',
    agentTeams,
    executionProbePath: withPathSuffix(env.SLACK_E2E_EXECUTION_PROBE_PATH, `${runSuffix}-app1`),
    instanceLabel: 'bootstrap:a2a-role-lead',
    sessionDbPath: appOneSessionDbPath,
    statusProbePath: withPathSuffix(env.SLACK_E2E_STATUS_PROBE_PATH, `${runSuffix}-app1`),
  });
  const appTwo = createLiveApplication({
    a2aCoordinatorDbPath: coordinatorDbPath,
    a2aDiagnosticsDir: diagnosticsDir,
    a2aOutputMode: 'quiet',
    agentTeams,
    executionProbePath: withPathSuffix(env.SLACK_E2E_EXECUTION_PROBE_PATH, `${runSuffix}-app2`),
    instanceLabel: 'bootstrap:a2a-role-standby',
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

    const rootMessage = await postMessageWithRetry(triggerClient, {
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: [
        `<!subteam^${teamMentionId}|@kagura-agents> A2A_ROLE_HANDOFF ${runId}`,
        'This is a Slack A2A host test. Do not use tools.',
        `The lead must inspect its A2A roster and find the available agent whose role contains "${roleMarker}".`,
        `The user message intentionally does not name that standby bot. Use the A2A roster, not this message text, to find the Slack mention token.`,
        `The lead app <@${appOneIdentity.user_id}> must reply exactly "<@that-role-agent> A2A_ROLE_HANDOFF_ASSIGN ${runId}", replacing <@that-role-agent> with the matched agent mention token.`,
        `When the standby app receives A2A_ROLE_HANDOFF_ASSIGN ${runId}, it must reply exactly "A2A_ROLE_STANDBY_DONE ${runId} ${STANDBY_REPLY_CODEWORD}".`,
        `When a later user reply contains "A2A_QUIET_FINAL_REQUEST ${runId}", the lead app <@${appOneIdentity.user_id}> must reply exactly "A2A_QUIET_FINAL ${runId}".`,
      ].join('\n'),
      unfurl_links: false,
      unfurl_media: false,
    });
    result.rootMessageTs = rootMessage.ts;

    const handoff = await waitForBotReply({
      botClient: appOneClient,
      botUserId: appOneIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: rootMessage.ts,
      textIncludes: `<@${appTwoIdentity.user_id}> A2A_ROLE_HANDOFF_ASSIGN ${runId}`,
    });
    result.matched.roleBasedLeadHandoffObserved = true;

    await waitForBotReply({
      botClient: appTwoClient,
      botUserId: appTwoIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: handoff.ts,
      textIncludes: `A2A_ROLE_STANDBY_DONE ${runId} ${STANDBY_REPLY_CODEWORD}`,
    });
    result.matched.standbyRoleReplyObserved = true;
    await waitForBothAppsToSettle(appOne, appTwo, rootMessage.ts);

    const quietPrompt = await postMessageWithRetry(triggerClient, {
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: `A2A_QUIET_FINAL_REQUEST ${runId}`,
      thread_ts: rootMessage.ts,
      unfurl_links: false,
      unfurl_media: false,
    });
    await waitForBotReply({
      botClient: appOneClient,
      botUserId: appOneIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: quietPrompt.ts,
      textIncludes: `A2A_QUIET_FINAL ${runId}`,
    });
    result.matched.quietFinalObserved = true;

    result.matched.diagnosticsCapturedQuietFinal = await waitForDiagnosticsRecord({
      diagnosticsDir,
      textIncludes: `A2A_QUIET_FINAL ${runId}`,
      threadTs: rootMessage.ts,
    });

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

async function waitForDiagnosticsRecord(input: {
  diagnosticsDir: string;
  textIncludes: string;
  threadTs: string;
}): Promise<boolean> {
  const filePath = path.join(
    path.resolve(process.cwd(), input.diagnosticsDir),
    `${input.threadTs.replaceAll(/[^\w.-]/gu, '_')}.jsonl`,
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const raw = await fs.readFile(filePath, 'utf8').catch(() => '');
    if (raw.includes(input.textIncludes)) {
      return true;
    }
    await delay(1_000);
  }
  return false;
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

function assertResult(result: A2ARoleHandoffResult): void {
  const failures: string[] = [];
  if (!result.matched.roleBasedLeadHandoffObserved) {
    failures.push('lead did not use role roster to mention the standby agent');
  }
  if (!result.matched.standbyRoleReplyObserved) {
    failures.push('standby agent did not reply after role-based handoff');
  }
  if (!result.matched.quietFinalObserved) {
    failures.push('quiet-mode final non-mention reply was not posted');
  }
  if (!result.matched.diagnosticsCapturedQuietFinal) {
    failures.push('quiet-mode diagnostics did not capture the suppressed final assistant message');
  }
  if (failures.length > 0) {
    throw new Error(`A2A role-handoff E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: A2ARoleHandoffResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'dual-agent-a2a-role-handoff-result.json',
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
  id: 'dual-agent-a2a-role-handoff',
  title: 'Dual Agent A2A Role Handoff',
  description:
    'Verify A2A roster roles are injected so the lead can mention the right standby agent, and quiet mode still publishes handoffs while recording diagnostics.',
  keywords: ['dual-agent', 'a2a', 'role', 'roster', 'handoff', 'quiet', 'diagnostics'],
  run: main,
};

runDirectly(scenario);
