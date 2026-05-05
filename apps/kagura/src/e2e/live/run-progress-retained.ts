import './load-e2e-env.js';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { env } from '~/env/server.js';
import type { SlackStatusProbeRecord } from '~/slack/render/status-probe.js';

import { readSlackStatusProbeFile, resetSlackStatusProbeFile } from './file-slack-status-probe.js';
import { createLiveApplication } from './live-application.js';
import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import { SlackApiClient, type SlackConversationRepliesResponse } from './slack-api-client.js';

interface ProgressRetainedResult {
  assistantReplyText?: string;
  assistantReplyTs?: string;
  botUserId: string;
  channelId: string;
  failureMessage?: string;
  finalizedMessageBlocks?: unknown[] | undefined;
  finalizedMessageText?: string | undefined;
  matched: {
    assistantReplied: boolean;
    progressMessageFinalized: boolean;
    progressMessageDeleted: boolean;
    progressMessageHasNoToolHistory: boolean;
    progressMessagePosted: boolean;
    progressMessageRetainedInThread: boolean;
  };
  passed: boolean;
  probeRecords: SlackStatusProbeRecord[];
  rootMessageTs?: string;
  runId: string;
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the progress-retained E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error('Live E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.');
  }

  const runId = randomUUID();
  const targetRepo = process.env.SLACK_E2E_TARGET_REPO?.trim() || process.cwd();
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();

  await resetSlackStatusProbeFile(env.SLACK_E2E_STATUS_PROBE_PATH);

  const result: ProgressRetainedResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    matched: {
      assistantReplied: false,
      progressMessageFinalized: false,
      progressMessageDeleted: false,
      progressMessageHasNoToolHistory: false,
      progressMessagePosted: false,
      progressMessageRetainedInThread: false,
    },
    passed: false,
    probeRecords: [],
    runId,
  };

  const application = createLiveApplication();
  let caughtError: unknown;

  try {
    await application.start();
    await delay(3_000);

    const prompt = [
      `<@${botIdentity.user_id}> PROGRESS_RETAINED_E2E ${runId}`,
      `Use repository ${targetRepo} for this task.`,
      'Please read the file src/slack/render/slack-renderer.ts and briefly describe what it does.',
      'Use file-reading tools so that progress updates are visible.',
      `Reply with exactly one line: "RETAINED_OK ${runId} <brief description>".`,
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

      const probeRecords = await readSlackStatusProbeFile(env.SLACK_E2E_STATUS_PROBE_PATH);
      result.probeRecords = probeRecords.filter((r) => r.threadTs === rootMessage.ts);

      for (const record of result.probeRecords) {
        if (record.kind === 'progress-message') {
          if (record.action === 'post') {
            result.matched.progressMessagePosted = true;
          } else if (record.action === 'finalize') {
            result.matched.progressMessageFinalized = true;
          } else if (record.action === 'delete') {
            result.matched.progressMessageDeleted = true;
          }
        }
      }

      const assistantReply = findAssistantReply(replies, rootMessage.ts, runId);
      if (assistantReply) {
        result.assistantReplyText = assistantReply.text;
        result.assistantReplyTs = assistantReply.ts;
        result.matched.assistantReplied = true;
      }

      if (
        result.matched.assistantReplied &&
        (result.matched.progressMessageFinalized || result.matched.progressMessageDeleted)
      ) {
        await delay(2_000);

        const finalReplies = await botClient.conversationReplies({
          channel: env.SLACK_E2E_CHANNEL_ID,
          inclusive: true,
          limit: 50,
          ts: rootMessage.ts,
        });

        if (result.matched.progressMessageDeleted) {
          result.matched.progressMessageRetainedInThread = false;
          result.matched.progressMessageHasNoToolHistory = true;
        } else {
          const finalizedTs = findFinalizedProgressMessageTs(result.probeRecords);
          const retained = findMessageByTs(finalReplies, finalizedTs);
          if (retained) {
            result.matched.progressMessageRetainedInThread = true;
            result.finalizedMessageText = retained.text ?? undefined;
            result.finalizedMessageBlocks = retained.blocks ?? undefined;
            result.matched.progressMessageHasNoToolHistory = !containsToolHistory(
              retained.text,
              retained.blocks,
            );
          }
        }
        break;
      }

      await delay(2_500);
    }

    await writeResult(result);
    assertResult(result);
    result.passed = true;
    await writeResult(result);

    console.info('Live progress-retained E2E passed.');
    console.info('Root thread: %s', result.rootMessageTs);
    console.info('Assistant reply: %s', result.assistantReplyTs);
    console.info('Progress finalized: %s', result.matched.progressMessageFinalized);
    console.info('Progress deleted: %s', result.matched.progressMessageDeleted);
    console.info('Retained in thread: %s', result.matched.progressMessageRetainedInThread);
    console.info(
      'Retained progress has no tool history: %s',
      result.matched.progressMessageHasNoToolHistory,
    );
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

function findAssistantReply(
  replies: SlackConversationRepliesResponse,
  rootTs: string,
  runId: string,
): { text: string; ts: string } | undefined {
  return replies.messages?.find((msg) => {
    if (!msg.ts || msg.ts === rootTs || typeof msg.text !== 'string') return false;
    return msg.text.includes(`RETAINED_OK ${runId}`);
  }) as { text: string; ts: string } | undefined;
}

function findFinalizedProgressMessageTs(
  probeRecords: SlackStatusProbeRecord[],
): string | undefined {
  for (const record of probeRecords) {
    if (record.kind === 'progress-message' && record.action === 'finalize' && record.messageTs) {
      return record.messageTs;
    }
  }
  return undefined;
}

function findMessageByTs(
  replies: SlackConversationRepliesResponse,
  ts: string | undefined,
): { blocks?: unknown[] | undefined; text?: string | undefined } | undefined {
  if (!ts) return undefined;
  const msg = replies.messages?.find((m) => m.ts === ts);
  if (!msg) return undefined;
  return { text: msg.text, blocks: msg.blocks };
}

function containsToolHistory(text?: string, blocks?: unknown[]): boolean {
  if (typeof text === 'string' && /\b[A-Z][a-z]+ x\d+\b/.test(text)) {
    return true;
  }

  for (const block of (blocks ?? []) as Array<{
    elements?: Array<Record<string, unknown>>;
    type?: string;
  }>) {
    if (block.type !== 'context') continue;
    for (const element of block.elements ?? []) {
      const value = typeof element.text === 'string' ? element.text : '';
      if (/\b[A-Z][a-z]+ x\d+\b/.test(value)) {
        return true;
      }
    }
  }

  return false;
}

function assertResult(result: ProgressRetainedResult): void {
  const failures: string[] = [];

  if (!result.matched.assistantReplied) {
    failures.push('assistant did not reply within timeout');
  }
  if (!result.matched.progressMessagePosted) {
    failures.push('progress message was never posted');
  }
  if (!result.matched.progressMessageFinalized && !result.matched.progressMessageDeleted) {
    failures.push('progress message was neither finalized nor deleted');
  }
  if (result.matched.progressMessageFinalized && !result.matched.progressMessageRetainedInThread) {
    failures.push('finalized progress message is not visible in thread replies');
  }
  if (result.matched.progressMessageFinalized && !result.matched.progressMessageHasNoToolHistory) {
    failures.push('finalized progress message still contains tool-history summary text');
  }

  if (failures.length > 0) {
    throw new Error(`Live progress-retained E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: ProgressRetainedResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'progress-retained-result.json',
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
  id: 'progress-retained',
  title: 'Progress Message Cleaned Up After Reply',
  description:
    'Verify that the progress message is cleaned up when the assistant replies, either by deletion or by finalizing without tool-history summary text.',
  keywords: ['progress', 'retained', 'finalize', 'cleanup', 'collapse'],
  run: main,
};

runDirectly(scenario);
