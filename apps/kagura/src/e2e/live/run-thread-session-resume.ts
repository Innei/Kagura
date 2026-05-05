import './load-e2e-env.js';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';

import type {
  ClaudeExecutionProbeLifecycleRecord,
  ClaudeExecutionProbeRecord,
  ClaudeExecutionProbeRequestRecord,
  ClaudeExecutionProbeSessionRecord,
} from '~/agent/providers/claude-code/execution-probe.js';
import { createApplication } from '~/application.js';
import { env } from '~/env/server.js';

import {
  readClaudeExecutionProbeFile,
  resetClaudeExecutionProbeFile,
} from './file-claude-execution-probe.js';
import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import {
  SlackApiClient,
  type SlackConversationRepliesResponse,
  type SlackPostedMessageResponse,
} from './slack-api-client.js';

interface ThreadSessionResumeResult {
  botUserId: string;
  channelId: string;
  failureMessage?: string;
  firstExecutionId?: string;
  firstPersistedSessionId?: string;
  matched: {
    firstExecutionRequested: boolean;
    firstExecutionSuperseded: boolean;
    firstSessionPersisted: boolean;
    secondExecutionResumed: boolean;
    secondReplyObserved: boolean;
  };
  passed: boolean;
  probePath: string;
  rootMessageTs?: string;
  runId: string;
  secondExecutionId?: string;
  secondReplyText?: string;
  secondReplyTs?: string;
  secondUserMessageTs?: string;
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the thread-session-resume E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error(
      'Live thread session resume E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.',
    );
  }

  const runId = randomUUID();
  const targetRepo = process.env.SLACK_E2E_TARGET_REPO?.trim() || 'kagura';
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();

  await resetClaudeExecutionProbeFile(env.SLACK_E2E_EXECUTION_PROBE_PATH);

  const result: ThreadSessionResumeResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    matched: {
      firstExecutionRequested: false,
      firstExecutionSuperseded: false,
      firstSessionPersisted: false,
      secondExecutionResumed: false,
      secondReplyObserved: false,
    },
    passed: false,
    probePath: env.SLACK_E2E_EXECUTION_PROBE_PATH,
    runId,
  };

  const application = createApplication();
  let caughtError: unknown;

  try {
    await application.start();
    await delay(3_000);

    const rootMessage = await postInitialMessage(
      triggerClient,
      botIdentity.user_id,
      runId,
      targetRepo,
    );
    result.rootMessageTs = rootMessage.ts;
    console.info('[e2e] Posted initial message: %s', rootMessage.ts);

    const firstRequest = await waitForFirstExecutionRequest(rootMessage.ts);
    result.matched.firstExecutionRequested = true;
    result.firstExecutionId = firstRequest.executionId;
    console.info('[e2e] First execution observed: %s', firstRequest.executionId);

    await waitForBotThreadActivity({
      botUserId: botIdentity.user_id,
      rootTs: rootMessage.ts,
      triggerClient,
    });

    const secondUserMessage = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: [
        `<@${botIdentity.user_id}>`,
        `THREAD_SESSION_RESUME_E2E ${runId}`,
        `Please stop the previous task and reply with exactly "THREAD_SESSION_RESUME_OK ${runId}".`,
        'Reply with that exact line only.',
      ].join(' '),
      thread_ts: rootMessage.ts,
      unfurl_links: false,
      unfurl_media: false,
    });
    result.secondUserMessageTs = secondUserMessage.ts;
    console.info('[e2e] Posted second thread message: %s', secondUserMessage.ts);

    await waitForResumeAssertions({
      botUserId: botIdentity.user_id,
      result,
      rootMessage,
      secondUserMessageTs: secondUserMessage.ts,
      triggerClient,
    });

    assertResult(result);
    result.passed = true;
    await writeResult(result);
    console.info('[e2e] Thread session resume E2E passed.');
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error);
    caughtError = error;
  } finally {
    await writeResult(result).catch((error) => {
      console.error('Failed to persist thread-session-resume result:', error);
    });
    await application.stop().catch((error) => {
      console.error('Failed to stop application:', error);
    });
  }

  if (caughtError) {
    throw caughtError;
  }
}

async function postInitialMessage(
  triggerClient: SlackApiClient,
  botUserId: string,
  runId: string,
  targetRepo: string,
): Promise<SlackPostedMessageResponse> {
  const prompt = [
    `<@${botUserId}> [e2e:${runId}] ${targetRepo}`,
    'Inspect this workspace thoroughly.',
    'Enumerate every file in the project root, then explain what each file does in detail.',
    'After that, continue with a detailed summary of the src and tests directories.',
    'Do not compress the answer into a short summary.',
  ].join(' ');

  return triggerClient.postMessage({
    channel: env.SLACK_E2E_CHANNEL_ID!,
    text: prompt,
    unfurl_links: false,
    unfurl_media: false,
  });
}

async function waitForFirstExecutionRequest(
  threadTs: string,
): Promise<ClaudeExecutionProbeRequestRecord> {
  const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const request = await readFirstRequest(threadTs);
    if (request) {
      return request;
    }
    await delay(250);
  }

  throw new Error('First execution request was not observed in the execution probe.');
}

async function waitForResumeAssertions(input: {
  botUserId: string;
  result: ThreadSessionResumeResult;
  rootMessage: SlackPostedMessageResponse;
  secondUserMessageTs: string;
  triggerClient: SlackApiClient;
}): Promise<void> {
  const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const probeRecords = await readThreadProbeRecords(input.rootMessage.ts);
    const requestRecords = probeRecords.filter(isRequestRecord);
    const lifecycleRecords = probeRecords.filter(isLifecycleRecord);
    const sessionRecords = probeRecords.filter(isSessionRecord);
    const firstRequest = requestRecords[0];
    const secondRequest = requestRecords[1];
    const firstStopped = firstRequest
      ? lifecycleRecords.find(
          (record) =>
            record.executionId === firstRequest.executionId &&
            record.phase === 'stopped' &&
            record.reason === 'superseded',
        )
      : undefined;
    const firstSessionRecord = firstRequest
      ? sessionRecords.find((record) => record.executionId === firstRequest.executionId)
      : undefined;
    const firstPersistedSessionId =
      firstStopped?.resumeHandle ?? firstSessionRecord?.sessionId ?? undefined;

    if (firstStopped) {
      input.result.matched.firstExecutionSuperseded = true;
    }
    if (firstPersistedSessionId) {
      input.result.matched.firstSessionPersisted = true;
      input.result.firstPersistedSessionId = firstPersistedSessionId;
    }
    if (secondRequest) {
      input.result.secondExecutionId = secondRequest.executionId;
    }

    if (
      firstStopped &&
      secondRequest &&
      firstPersistedSessionId &&
      secondRequest.resumeHandle === firstPersistedSessionId &&
      Date.parse(secondRequest.recordedAt) >= Date.parse(firstStopped.recordedAt)
    ) {
      input.result.matched.secondExecutionResumed = true;
    }

    const sessionRow = readSessionRow(input.rootMessage.ts);
    if (sessionRow?.providerSessionId) {
      input.result.firstPersistedSessionId ??= sessionRow.providerSessionId;
      input.result.matched.firstSessionPersisted = true;
    }

    const replies = await input.triggerClient.conversationReplies({
      channel: env.SLACK_E2E_CHANNEL_ID!,
      inclusive: true,
      limit: 100,
      ts: input.rootMessage.ts,
    });
    const secondReply = findSecondReply(
      replies,
      input.rootMessage,
      input.secondUserMessageTs,
      input.botUserId,
      input.result.runId,
    );
    if (secondReply) {
      input.result.secondReplyText = secondReply.text;
      input.result.secondReplyTs = secondReply.ts;
      input.result.matched.secondReplyObserved = true;
    }

    if (
      input.result.matched.firstExecutionSuperseded &&
      input.result.matched.firstSessionPersisted &&
      input.result.matched.secondExecutionResumed &&
      input.result.matched.secondReplyObserved
    ) {
      return;
    }

    await delay(2_000);
  }
}

async function waitForBotThreadActivity(input: {
  botUserId: string;
  rootTs: string;
  triggerClient: SlackApiClient;
}): Promise<void> {
  const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const replies = await input.triggerClient.conversationReplies({
      channel: env.SLACK_E2E_CHANNEL_ID!,
      inclusive: true,
      limit: 50,
      ts: input.rootTs,
    });

    const botMessageSeen = replies.messages?.some(
      (message) =>
        message.ts &&
        message.ts !== input.rootTs &&
        (message.user === input.botUserId || Boolean(message.bot_id)),
    );
    if (botMessageSeen) {
      return;
    }

    await delay(1_000);
  }

  throw new Error('Timed out waiting for the first bot-authored thread activity.');
}

async function readFirstRequest(
  threadTs: string,
): Promise<ClaudeExecutionProbeRequestRecord | undefined> {
  const probeRecords = await readThreadProbeRecords(threadTs);
  return probeRecords.find(isRequestRecord);
}

async function readThreadProbeRecords(threadTs: string): Promise<ClaudeExecutionProbeRecord[]> {
  const records = await readClaudeExecutionProbeFile(env.SLACK_E2E_EXECUTION_PROBE_PATH);
  return records.filter((record) => record.threadTs === threadTs);
}

function findSecondReply(
  replies: SlackConversationRepliesResponse,
  rootMessage: SlackPostedMessageResponse,
  secondUserMessageTs: string,
  botUserId: string,
  runId: string,
): { text: string; ts: string } | undefined {
  return replies.messages?.find((message) => {
    if (!message.ts || message.ts === rootMessage.ts || message.ts === secondUserMessageTs) {
      return false;
    }
    if (!message.text?.includes(`THREAD_SESSION_RESUME_OK ${runId}`)) {
      return false;
    }
    return message.user === botUserId || Boolean(message.bot_id);
  }) as { text: string; ts: string } | undefined;
}

function readSessionRow(
  threadTs: string,
): { providerSessionId?: string | undefined; threadTs: string } | undefined {
  const dbPath = path.resolve(process.cwd(), env.SESSION_DB_PATH);
  const sqlite = new Database(dbPath, { readonly: true });

  try {
    const row = sqlite
      .prepare(
        `
          SELECT thread_ts AS threadTs, claude_session_id AS providerSessionId
          FROM sessions
          WHERE thread_ts = ?
        `,
      )
      .get(threadTs) as { providerSessionId?: string | null; threadTs: string } | undefined;

    if (!row) {
      return undefined;
    }

    return {
      threadTs: row.threadTs,
      ...(row.providerSessionId ? { providerSessionId: row.providerSessionId } : {}),
    };
  } finally {
    sqlite.close();
  }
}

function isRequestRecord(
  record: ClaudeExecutionProbeRecord,
): record is ClaudeExecutionProbeRequestRecord {
  return record.kind === 'request';
}

function isSessionRecord(
  record: ClaudeExecutionProbeRecord,
): record is ClaudeExecutionProbeSessionRecord {
  return record.kind === 'session';
}

function isLifecycleRecord(
  record: ClaudeExecutionProbeRecord,
): record is ClaudeExecutionProbeLifecycleRecord {
  return record.kind === 'lifecycle';
}

function assertResult(result: ThreadSessionResumeResult): void {
  const failures: string[] = [];

  if (!result.matched.firstExecutionRequested) {
    failures.push('first execution request was not observed');
  }
  if (!result.matched.firstExecutionSuperseded) {
    failures.push('first execution was not stopped with reason "superseded"');
  }
  if (!result.matched.firstSessionPersisted) {
    failures.push('first execution did not persist a Claude session id before resume');
  }
  if (!result.matched.secondExecutionResumed) {
    failures.push('second execution did not reuse the persisted Claude session id');
  }
  if (!result.matched.secondReplyObserved) {
    failures.push('second execution did not post the expected confirmation reply');
  }

  if (failures.length > 0) {
    throw new Error(`Thread session resume E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: ThreadSessionResumeResult): Promise<void> {
  const outputPath = path.resolve('data', 'thread-session-resume-result.json');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export const scenario: LiveE2EScenario = {
  id: 'thread-session-resume',
  provider: {
    kind: 'specific',
    providerId: 'claude-code',
    reason: 'Asserts Claude session id persistence and resume semantics.',
  },
  title: 'Thread Session Resume',
  description:
    'Starts a long-running thread execution, interrupts it with a second thread message, and asserts the second execution resumes the persisted Claude session instead of creating a fresh one.',
  keywords: ['thread', 'session', 'resume', 'superseded', 'conversation', 'pipeline'],
  run: main,
};

runDirectly(scenario);
