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

interface ToolProgressResult {
  assistantReplyText?: string;
  assistantReplyTs?: string;
  botUserId: string;
  channelId: string;
  failureMessage?: string;
  matched: {
    assistantReplied: boolean;
    replyContainsMarker: boolean;
    progressMessagePosted: boolean;
    progressMessageUpdated: boolean;
    noProgressDeleteDuringExecution: boolean;
    noToolHistoryInReply: boolean;
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
    throw new Error('Set SLACK_E2E_ENABLED=true before running the tool-progress E2E.');
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

  const result: ToolProgressResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    matched: {
      assistantReplied: false,
      replyContainsMarker: false,
      progressMessagePosted: false,
      progressMessageUpdated: false,
      noProgressDeleteDuringExecution: true,
      noToolHistoryInReply: false,
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
      `<@${botIdentity.user_id}> TOOL_PROGRESS_E2E ${runId}`,
      `Use repository ${targetRepo} for this task.`,
      'Read the file src/index.ts and also read package.json.',
      'Use the file-reading tools for both files.',
      `Reply with exactly one line: "PROGRESS_OK ${runId} done".`,
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

        if (message.text.includes(`PROGRESS_OK ${runId}`)) {
          result.assistantReplyText = message.text;
          result.assistantReplyTs = message.ts;
          result.matched.assistantReplied = true;
          result.matched.replyContainsMarker = true;
          result.replyBlocks = message.blocks ?? [];

          result.matched.noToolHistoryInReply = !hasToolHistoryContextBlock(message.blocks);
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

    analyzeProbeRecords(result);
    await writeResult(result);
    assertResult(result);
    result.passed = true;
    await writeResult(result);

    console.info('Live tool-progress E2E passed.');
    console.info('Root thread: %s', result.rootMessageTs);
    console.info('Assistant reply: %s', result.assistantReplyTs);
    console.info('Progress posted: %s', result.matched.progressMessagePosted);
    console.info('Progress updated: %s', result.matched.progressMessageUpdated);
    console.info('No mid-execution delete: %s', result.matched.noProgressDeleteDuringExecution);
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

function hasToolHistoryContextBlock(
  blocks?: Array<{ elements?: Array<Record<string, unknown>>; type?: string }>,
): boolean {
  if (!blocks) return false;
  return blocks.some(
    (block) =>
      block.type === 'context' &&
      block.elements?.some((el) => {
        const text = typeof el.text === 'string' ? el.text : '';
        return text.length > 0 && !text.includes('Working in');
      }),
  );
}

function analyzeProbeRecords(result: ToolProgressResult): void {
  const progressRecords = result.probeRecords.filter(
    (r): r is Extract<SlackStatusProbeRecord, { kind: 'progress-message' }> =>
      r.kind === 'progress-message',
  );

  for (const record of progressRecords) {
    if (record.action === 'post') {
      result.matched.progressMessagePosted = true;
    }
    if (record.action === 'update') {
      result.matched.progressMessageUpdated = true;
    }
  }

  let deleteCount = 0;
  let postCount = 0;
  for (const record of progressRecords) {
    if (record.action === 'post') postCount++;
    if (record.action === 'delete') deleteCount++;
  }

  if (postCount > 1) {
    result.matched.noProgressDeleteDuringExecution = false;
  } else {
    result.matched.noProgressDeleteDuringExecution = true;
  }
}

function assertResult(result: ToolProgressResult): void {
  const failures: string[] = [];

  if (!result.matched.assistantReplied) {
    failures.push('assistant did not reply within timeout');
  }
  if (!result.matched.replyContainsMarker) {
    failures.push(`reply does not contain expected marker "PROGRESS_OK ${result.runId}"`);
  }
  if (!result.matched.progressMessagePosted) {
    failures.push('no progress message was posted during execution');
  }
  if (!result.matched.noProgressDeleteDuringExecution) {
    failures.push('progress message was deleted during execution — expected update-in-place only');
  }
  if (!result.matched.noToolHistoryInReply) {
    failures.push('final reply still contains a tool history context block');
  }

  if (failures.length > 0) {
    throw new Error(`Live tool-progress E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: ToolProgressResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'tool-progress-result.json',
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
  id: 'tool-progress',
  title: 'Tool Progress Stability',
  description:
    'Verify that progress messages use stable context-only layout, are never deleted mid-execution, ' +
    'and the final reply does not retain tool-history context blocks after completion.',
  keywords: ['progress', 'tool', 'history', 'context', 'stable', 'flicker'],
  run: main,
};

runDirectly(scenario);
