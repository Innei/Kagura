import './load-e2e-env.js';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { env } from '~/env/server.js';
import type { SlackStatusProbeRecord } from '~/slack/render/status-probe.js';

import {
  THINKING_LOADING_MESSAGES,
  THINKING_STATUS_MESSAGES,
} from '../../slack/thinking-messages.js';
import { readSlackStatusProbeFile, resetSlackStatusProbeFile } from './file-slack-status-probe.js';
import { createLiveApplication } from './live-application.js';
import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import { SlackApiClient } from './slack-api-client.js';

interface NoThinkingAfterReplyResult {
  assistantReplyText?: string;
  assistantReplyTs?: string;
  botUserId: string;
  channelId: string;
  failureMessage?: string;
  matched: {
    assistantReplied: boolean;
    clearAfterReply: boolean;
    noThinkingAfterClear: boolean;
  };
  passed: boolean;
  probePath: string;
  probeRecords: SlackStatusProbeRecord[];
  rootMessageTs?: string;
  runId: string;
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the no-thinking-after-reply E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error('Live E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.');
  }

  const runId = randomUUID();
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();

  await resetSlackStatusProbeFile(env.SLACK_E2E_STATUS_PROBE_PATH);

  const result: NoThinkingAfterReplyResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    matched: {
      assistantReplied: false,
      clearAfterReply: false,
      noThinkingAfterClear: false,
    },
    passed: false,
    probePath: env.SLACK_E2E_STATUS_PROBE_PATH,
    probeRecords: [],
    runId,
  };

  const application = createLiveApplication();
  let caughtError: unknown;

  try {
    await application.start();
    await delay(3_000);

    const prompt = [
      `<@${botIdentity.user_id}> NO_THINKING_AFTER_REPLY_E2E ${runId}`,
      'What is 3 + 5? Reply with exactly one line:',
      `"REPLY_OK ${runId} <your answer>".`,
      'Do not use any file or code tools. Just reply directly.',
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

      for (const message of replies.messages ?? []) {
        if (!message.ts || message.ts === rootMessage.ts) continue;
        if (typeof message.text === 'string' && message.text.includes(`REPLY_OK ${runId}`)) {
          result.assistantReplyText = message.text;
          result.assistantReplyTs = message.ts;
          result.matched.assistantReplied = true;
        }
      }

      if (result.matched.assistantReplied) {
        await delay(2_000);
        break;
      }

      await delay(2_500);
    }

    const probeRecords = await readSlackStatusProbeFile(env.SLACK_E2E_STATUS_PROBE_PATH);
    result.probeRecords = probeRecords.filter((record) => record.threadTs === rootMessage.ts);

    analyzeProbeSequence(result);
    await writeResult(result);
    assertResult(result);
    result.passed = true;
    await writeResult(result);

    console.info('Live no-thinking-after-reply E2E passed.');
    console.info('Root thread: %s', result.rootMessageTs);
    console.info('Assistant reply: %s', result.assistantReplyTs);
    console.info('Probe records for thread: %d', result.probeRecords.length);
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

function isDefaultThinkingStatus(record: SlackStatusProbeRecord): boolean {
  if (record.kind !== 'status') return false;
  if (record.clear) return false;
  if (
    !THINKING_STATUS_MESSAGES.includes(record.status as (typeof THINKING_STATUS_MESSAGES)[number])
  )
    return false;

  const messages = record.loadingMessages ?? [];
  if (messages.length === 0) return true;

  return messages.every((m) =>
    THINKING_LOADING_MESSAGES.includes(m as (typeof THINKING_LOADING_MESSAGES)[number]),
  );
}

function analyzeProbeSequence(result: NoThinkingAfterReplyResult): void {
  const statusRecords = result.probeRecords.filter(
    (r): r is Extract<SlackStatusProbeRecord, { kind: 'status' }> => r.kind === 'status',
  );

  let seenClear = false;
  for (const record of statusRecords) {
    if (record.clear) {
      seenClear = true;
      result.matched.clearAfterReply = true;
      continue;
    }

    if (seenClear && isDefaultThinkingStatus(record)) {
      result.matched.noThinkingAfterClear = false;
      return;
    }
  }

  result.matched.noThinkingAfterClear = true;
}

function assertResult(result: NoThinkingAfterReplyResult): void {
  const failures: string[] = [];

  if (!result.matched.assistantReplied) {
    failures.push('assistant did not reply within timeout');
  }
  if (!result.matched.clearAfterReply) {
    failures.push('no clear status event observed in probe');
  }
  if (!result.matched.noThinkingAfterClear) {
    failures.push(
      'a default thinking status was re-set after a clear — ' +
        'expected clear to be final with no thinking restoration',
    );
  }

  if (failures.length > 0) {
    throw new Error(`Live no-thinking-after-reply E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: NoThinkingAfterReplyResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'no-thinking-after-reply-result.json',
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
  id: 'no-thinking-after-reply',
  title: 'No Thinking After Reply',
  description:
    'Verify that a default thinking status is not re-set after the assistant posts a reply. ' +
    'After a clear event, no default thinking status should reappear.',
  keywords: ['thinking', 'status', 'clear', 'reply', 'loading', 'flash'],
  run: main,
};

runDirectly(scenario);
