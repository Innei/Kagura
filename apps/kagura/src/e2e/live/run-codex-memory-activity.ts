import './load-e2e-env.js';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';

import { createApplication } from '~/application.js';
import { env } from '~/env/server.js';
import type { SlackStatusProbeRecord } from '~/slack/render/status-probe.js';

import { readSlackStatusProbeFile, resetSlackStatusProbeFile } from './file-slack-status-probe.js';
import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import {
  SlackApiClient,
  type SlackConversationRepliesResponse,
  type SlackPostedMessageResponse,
} from './slack-api-client.js';

interface CodexMemoryActivityResult {
  assistantReplyText?: string;
  assistantReplyTs?: string;
  botUserId: string;
  channelId: string;
  failureMessage?: string;
  matched: {
    assistantReplied: boolean;
    conciseSavingActivityObserved: boolean;
    memoryPersisted: boolean;
    noRawMemoryCommandVisible: boolean;
    replyContainsMarker: boolean;
  };
  passed: boolean;
  probePath: string;
  probeRecords: SlackStatusProbeRecord[];
  rawLeakSamples: string[];
  rootMessageTs?: string;
  runId: string;
  savedMarker: string;
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the Codex memory activity E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error(
      'Live Codex memory activity E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.',
    );
  }

  const runId = randomUUID();
  const savedMarker = `CODEX_MEMORY_ACTIVITY_MARKER ${runId}`;
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();

  await resetSlackStatusProbeFile(env.SLACK_E2E_STATUS_PROBE_PATH);

  const result: CodexMemoryActivityResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    matched: {
      assistantReplied: false,
      conciseSavingActivityObserved: false,
      memoryPersisted: false,
      noRawMemoryCommandVisible: false,
      replyContainsMarker: false,
    },
    passed: false,
    probePath: env.SLACK_E2E_STATUS_PROBE_PATH,
    probeRecords: [],
    rawLeakSamples: [],
    runId,
    savedMarker,
  };

  const application = createApplication({ defaultProviderId: 'codex-cli' });
  let caughtError: unknown;

  try {
    await application.start();
    await delay(3_000);

    const prompt = [
      `<@${botIdentity.user_id}> CODEX_MEMORY_ACTIVITY_E2E ${runId}`,
      'This is a general question, no code or repository involved.',
      `Before your reply, call save_memory with category "decision", scope "global", and content exactly "${savedMarker}".`,
      'Do not paraphrase the saved memory content.',
      `Reply with exactly one line: "CODEX_MEMORY_ACTIVITY_OK ${runId}".`,
      'Do not use any other tools.',
    ].join(' ');

    const rootMessage = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: prompt,
      unfurl_links: false,
      unfurl_media: false,
    });
    result.rootMessageTs = rootMessage.ts;
    console.info('Posted root message: %s', rootMessage.ts);

    const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const replies = await botClient.conversationReplies({
        channel: env.SLACK_E2E_CHANNEL_ID,
        inclusive: true,
        limit: 50,
        ts: rootMessage.ts,
      });

      const reply = findReplyWithMarker(replies, rootMessage, `CODEX_MEMORY_ACTIVITY_OK ${runId}`);
      if (reply) {
        result.assistantReplyText = reply.text;
        result.assistantReplyTs = reply.ts;
        result.matched.assistantReplied = true;
        result.matched.replyContainsMarker = true;
      }

      result.probeRecords = (
        await readSlackStatusProbeFile(env.SLACK_E2E_STATUS_PROBE_PATH)
      ).filter((record) => record.threadTs === rootMessage.ts);
      analyzeProbeRecords(result);

      if (readGlobalMemories(savedMarker).length > 0) {
        result.matched.memoryPersisted = true;
      }

      if (
        result.matched.assistantReplied &&
        result.matched.conciseSavingActivityObserved &&
        result.matched.memoryPersisted
      ) {
        break;
      }

      await delay(2_500);
    }

    result.probeRecords = (await readSlackStatusProbeFile(env.SLACK_E2E_STATUS_PROBE_PATH)).filter(
      (record) => record.threadTs === rootMessage.ts,
    );
    analyzeProbeRecords(result);

    await writeResult(result);
    assertResult(result);
    result.passed = true;
    await writeResult(result);

    console.info('Live Codex memory activity E2E passed.');
    console.info('Root thread: %s', result.rootMessageTs);
    console.info('Assistant reply: %s', result.assistantReplyTs);
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

function analyzeProbeRecords(result: CodexMemoryActivityResult): void {
  const visibleTexts = collectProbeVisibleTexts(result.probeRecords);
  result.matched.conciseSavingActivityObserved = visibleTexts.some((text) =>
    text.includes('Saving memory...'),
  );
  result.rawLeakSamples = visibleTexts.filter(isRawMemoryCommandLeak);
  result.matched.noRawMemoryCommandVisible = result.rawLeakSamples.length === 0;
}

function collectProbeVisibleTexts(records: readonly SlackStatusProbeRecord[]): string[] {
  const texts: string[] = [];
  for (const record of records) {
    if (record.kind === 'status') {
      if (record.status) texts.push(record.status);
      texts.push(...(record.loadingMessages ?? []));
      continue;
    }
    if (record.text) {
      texts.push(record.text);
    }
  }
  return texts;
}

function isRawMemoryCommandLeak(text: string): boolean {
  return (
    text.includes('/bin/zsh -lc') ||
    text.includes('.kagura/runtime') ||
    text.includes('memory-ops.jsonl')
  );
}

function findReplyWithMarker(
  replies: SlackConversationRepliesResponse,
  rootMessage: SlackPostedMessageResponse,
  marker: string,
): { text: string; ts: string } | undefined {
  return replies.messages?.find((message) => {
    if (!message.ts || message.ts === rootMessage.ts) return false;
    return typeof message.text === 'string' && message.text.includes(marker);
  }) as { text: string; ts: string } | undefined;
}

function readGlobalMemories(marker: string): Array<{ id: string }> {
  const dbPath = path.resolve(process.cwd(), env.SESSION_DB_PATH);
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    const statement = sqlite.prepare(`
      SELECT id
      FROM memories
      WHERE category = 'decision'
        AND repo_id IS NULL
        AND content = ?
      ORDER BY created_at DESC
      LIMIT 5
    `);
    return statement.all(marker) as Array<{ id: string }>;
  } finally {
    sqlite.close();
  }
}

function assertResult(result: CodexMemoryActivityResult): void {
  const failures: string[] = [];

  if (!result.matched.assistantReplied) {
    failures.push('assistant did not reply within timeout');
  }
  if (!result.matched.replyContainsMarker) {
    failures.push(
      `reply does not contain expected marker "CODEX_MEMORY_ACTIVITY_OK ${result.runId}"`,
    );
  }
  if (!result.matched.memoryPersisted) {
    failures.push('Codex save_memory operation was not persisted');
  }
  if (!result.matched.conciseSavingActivityObserved) {
    failures.push('Slack activity did not show the concise "Saving memory..." status');
  }
  if (!result.matched.noRawMemoryCommandVisible) {
    failures.push(
      `raw memory command leaked into Slack-visible status: ${result.rawLeakSamples.join(' | ')}`,
    );
  }

  if (failures.length > 0) {
    throw new Error(`Live Codex memory activity E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: CodexMemoryActivityResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'codex-memory-activity-result.json',
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
  id: 'codex-memory-activity',
  provider: {
    kind: 'specific',
    providerId: 'codex-cli',
    reason: 'Asserts Codex-specific memory activity rendering.',
  },
  title: 'Codex Memory Activity Rendering',
  description:
    'Verify Codex save_memory file writes render as a concise memory activity without exposing the raw shell command in Slack.',
  keywords: ['codex', 'memory', 'save_memory', 'activity', 'status', 'progress'],
  run: main,
};

runDirectly(scenario);
