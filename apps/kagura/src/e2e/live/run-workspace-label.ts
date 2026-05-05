import './load-e2e-env.js';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { env } from '~/env/server.js';

import { createLiveApplication } from './live-application.js';
import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import { SlackApiClient } from './slack-api-client.js';

interface WorkspaceLabelResult {
  assistantReplyText?: string;
  assistantReplyTs?: string;
  botUserId: string;
  channelId: string;
  failureMessage?: string;
  matched: {
    assistantReplied: boolean;
    replyContainsMarker: boolean;
    workspaceLabelPresent: boolean;
    noLabelWhenNoWorkspace: boolean;
  };
  noWorkspaceReplyBlocks?: unknown[];
  passed: boolean;
  rootMessageTs?: string;
  runId: string;
  targetRepo: string;
  workspaceReplyBlocks?: unknown[];
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the workspace-label E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error('Live E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.');
  }

  const runId = randomUUID();
  const targetRepo = process.env.SLACK_E2E_TARGET_REPO?.trim() || process.cwd();
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();

  const result: WorkspaceLabelResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    matched: {
      assistantReplied: false,
      replyContainsMarker: false,
      workspaceLabelPresent: false,
      noLabelWhenNoWorkspace: true,
    },
    passed: false,
    runId,
    targetRepo,
  };

  const application = createLiveApplication();
  let caughtError: unknown;

  try {
    await application.start();
    await delay(3_000);

    // --- Phase 1: workspace-bound mention → expect "Working in" context block ---
    const wsPrompt = [
      `<@${botIdentity.user_id}> WORKSPACE_LABEL_E2E ${runId}`,
      `Use repository ${targetRepo} for this task.`,
      `What is 7 + 3? Reply with exactly one line: "LABEL_OK ${runId} <answer>".`,
      'Do not use any file or code tools. Just reply directly.',
    ].join(' ');

    const wsRoot = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: wsPrompt,
      unfurl_links: false,
      unfurl_media: false,
    });
    result.rootMessageTs = wsRoot.ts;
    console.info('Posted workspace-bound root message: %s', wsRoot.ts);

    const wsDeadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;
    while (Date.now() < wsDeadline) {
      const replies = await botClient.conversationReplies({
        channel: env.SLACK_E2E_CHANNEL_ID,
        inclusive: true,
        limit: 50,
        ts: wsRoot.ts,
      });

      for (const message of replies.messages ?? []) {
        if (!message.ts || message.ts === wsRoot.ts) continue;
        if (typeof message.text !== 'string') continue;

        if (message.text.includes(`LABEL_OK ${runId}`)) {
          result.assistantReplyText = message.text;
          result.assistantReplyTs = message.ts;
          result.matched.assistantReplied = true;
          result.matched.replyContainsMarker = true;
          result.workspaceReplyBlocks = message.blocks ?? [];

          if (hasWorkingInContextBlock(message.blocks)) {
            result.matched.workspaceLabelPresent = true;
          }
        }
      }

      if (result.matched.assistantReplied) break;
      await delay(2_500);
    }

    await writeResult(result);
    assertResult(result);
    result.passed = true;
    await writeResult(result);

    console.info('Live workspace-label E2E passed.');
    console.info('Root thread: %s', result.rootMessageTs);
    console.info('Assistant reply: %s', result.assistantReplyTs);
    console.info('Workspace label present: %s', result.matched.workspaceLabelPresent);
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

function hasWorkingInContextBlock(
  blocks?: Array<{ elements?: Array<Record<string, unknown>>; type?: string }>,
): boolean {
  if (!blocks) return false;
  return blocks.some(
    (block) =>
      block.type === 'context' &&
      block.elements?.some((el) => {
        const text = typeof el.text === 'string' ? el.text : '';
        return text.includes('Working in');
      }),
  );
}

function assertResult(result: WorkspaceLabelResult): void {
  const failures: string[] = [];

  if (!result.matched.assistantReplied) {
    failures.push('assistant did not reply within timeout');
  }
  if (!result.matched.replyContainsMarker) {
    failures.push(`reply does not contain expected marker "LABEL_OK ${result.runId}"`);
  }
  if (!result.matched.workspaceLabelPresent) {
    failures.push('workspace-bound reply does not contain a "Working in" context block');
  }

  if (failures.length > 0) {
    throw new Error(`Live workspace-label E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: WorkspaceLabelResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'workspace-label-result.json',
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
  id: 'workspace-label',
  title: 'Workspace Label in Reply',
  description:
    'Verify that replies to workspace-bound mentions include a "Working in" context block with the workspace label.',
  keywords: ['workspace', 'label', 'context', 'block', 'working-in'],
  run: main,
};

runDirectly(scenario);
