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
import { SlackApiClient } from './slack-api-client.js';

interface ToolHistoryReappearanceResult {
  assistantReplyText?: string;
  assistantReplyTs?: string;
  botUserId: string;
  channelId: string;
  failureMessage?: string;
  matched: {
    assistantReplied: boolean;
    progressMessagePosted: boolean;
    progressMessageUpdated: boolean;
    noToolHistoryInReply: boolean;
    replyContainsMarker: boolean;
  };
  passed: boolean;
  probePath: string;
  probeRecords: SlackStatusProbeRecord[];
  replyBlocks?: unknown[];
  rootMessageTs?: string;
  runId: string;
  targetRepo: string;
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the tool-history-reappearance E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error('Live E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.');
  }

  const runId = randomUUID();
  const targetRepo = process.env.SLACK_E2E_TARGET_REPO?.trim() || 'kagura';
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();

  await resetSlackStatusProbeFile(env.SLACK_E2E_STATUS_PROBE_PATH);

  const result: ToolHistoryReappearanceResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    matched: {
      assistantReplied: false,
      progressMessagePosted: false,
      progressMessageUpdated: false,
      noToolHistoryInReply: false,
      replyContainsMarker: false,
    },
    passed: false,
    probePath: env.SLACK_E2E_STATUS_PROBE_PATH,
    probeRecords: [],
    runId,
    targetRepo,
  };

  const application = createLiveApplication();
  let caughtError: unknown;

  try {
    await application.start();
    await delay(3_000);

    const prompt = [
      `<@${botIdentity.user_id}> TOOL_HISTORY_REAPPEAR ${runId}`,
      `Use repository ${targetRepo} for this task.`,
      'This is a progress-accounting audit.',
      'Perform three separate file reads in this exact order:',
      'first read src/index.ts, then read package.json, then read src/index.ts again.',
      'Do not batch these reads together and do not skip the final re-read.',
      `Reply with exactly one line: "REAPPEAR_OK ${runId} done".`,
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
        if (typeof message.text !== 'string') continue;

        if (message.text.includes(`REAPPEAR_OK ${runId}`)) {
          result.assistantReplyText = message.text;
          result.assistantReplyTs = message.ts;
          result.matched.assistantReplied = true;
          result.matched.replyContainsMarker = true;
          result.replyBlocks = message.blocks ?? [];

          result.matched.noToolHistoryInReply = !hasToolHistoryContextBlock(message.blocks);
        }
      }

      const probeRecords = await readSlackStatusProbeFile(env.SLACK_E2E_STATUS_PROBE_PATH);
      result.probeRecords = probeRecords.filter((record) => record.threadTs === rootMessage.ts);
      analyzeProbeRecords(result);

      if (result.matched.assistantReplied) {
        await delay(2_000);
        break;
      }

      await delay(2_500);
    }

    await writeResult(result);
    assertResult(result);
    result.passed = true;
    await writeResult(result);

    console.info('Live tool-history-reappearance E2E passed.');
    console.info('Root thread: %s', result.rootMessageTs);
    console.info('Assistant reply: %s', result.assistantReplyTs);
    console.info('No tool history in reply: %s', result.matched.noToolHistoryInReply);
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

function analyzeProbeRecords(result: ToolHistoryReappearanceResult): void {
  const progressRecords = result.probeRecords.filter(
    (record): record is Extract<SlackStatusProbeRecord, { kind: 'progress-message' }> =>
      record.kind === 'progress-message',
  );

  for (const record of progressRecords) {
    if (record.action === 'post') {
      result.matched.progressMessagePosted = true;
    }
    if (record.action === 'update') {
      result.matched.progressMessageUpdated = true;
    }
  }
}

function hasToolHistoryContextBlock(
  blocks?: Array<{ elements?: Array<Record<string, unknown>>; type?: string }>,
): boolean {
  if (!blocks) return false;

  for (const block of blocks) {
    if (block.type !== 'context') continue;
    for (const element of block.elements ?? []) {
      const text = typeof element.text === 'string' ? element.text.trim() : '';
      if (!text || text.includes('Working in')) continue;
      if (/\b[A-Z][a-z]+ x\d+\b/.test(text)) {
        return true;
      }
    }
  }

  return false;
}

function assertResult(result: ToolHistoryReappearanceResult): void {
  const failures: string[] = [];

  if (!result.matched.assistantReplied) {
    failures.push('assistant did not reply within timeout');
  }
  if (!result.matched.replyContainsMarker) {
    failures.push(`reply does not contain expected marker "REAPPEAR_OK ${result.runId}"`);
  }
  if (!result.matched.progressMessagePosted) {
    failures.push('no progress message was posted during execution');
  }
  if (!result.matched.progressMessageUpdated) {
    failures.push('progress message was never updated during execution');
  }
  if (!result.matched.noToolHistoryInReply) {
    failures.push('final reply still contains a tool history context block');
  }

  if (failures.length > 0) {
    throw new Error(`Live tool-history-reappearance E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: ToolHistoryReappearanceResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'tool-history-reappearance-result.json',
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
  id: 'tool-history-reappearance',
  title: 'Repeated Tool Activity Stays Out Of Final Reply',
  description:
    'Verify that repeated file-reading activity still drives progress updates during execution, without leaking tool-history context into the final reply.',
  keywords: ['tool', 'history', 'reading', 'reappearance', 'progress', 'cleanup'],
  run: main,
};

runDirectly(scenario);
