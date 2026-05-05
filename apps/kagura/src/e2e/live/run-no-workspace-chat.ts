import './load-e2e-env.js';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { env } from '~/env/server.js';

import { createLiveApplication } from './live-application.js';
import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import { SlackApiClient } from './slack-api-client.js';

interface NoWorkspaceChatResult {
  assistantReplyText?: string;
  assistantReplyTs?: string;
  botUserId: string;
  channelId: string;
  failureMessage?: string;
  matched: {
    assistantReplied: boolean;
    noWorkspacePickerShown: boolean;
    replyContainsMarker: boolean;
  };
  passed: boolean;
  rootMessageTs?: string;
  runId: string;
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the no-workspace chat E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error(
      'Live no-workspace chat E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.',
    );
  }

  const runId = randomUUID();
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();

  const result: NoWorkspaceChatResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    matched: {
      assistantReplied: false,
      noWorkspacePickerShown: true,
      replyContainsMarker: false,
    },
    passed: false,
    runId,
  };

  const application = createLiveApplication();
  let caughtError: unknown;

  try {
    await application.start();
    await delay(3_000);

    const prompt = [
      `<@${botIdentity.user_id}> NO_WORKSPACE_CHAT_E2E ${runId}`,
      `This is a general knowledge question, no code involved.`,
      `What is 2 + 2? Reply with exactly one line: "CHAT_OK ${runId} <your answer>".`,
      `Do not use any file or code tools. Just reply directly.`,
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

        if (hasWorkspacePickerBlock(message)) {
          result.matched.noWorkspacePickerShown = false;
        }

        if (typeof message.text === 'string' && message.text.includes(`CHAT_OK ${runId}`)) {
          result.assistantReplyText = message.text;
          result.assistantReplyTs = message.ts;
          result.matched.assistantReplied = true;
          result.matched.replyContainsMarker = true;
        }
      }

      if (result.matched.assistantReplied) {
        break;
      }

      await delay(2_500);
    }

    await writeResult(result);
    assertResult(result);
    result.passed = true;
    await writeResult(result);

    console.info('Live no-workspace chat E2E passed.');
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

function hasWorkspacePickerBlock(message: {
  blocks?: Array<{
    elements?: Array<Record<string, unknown>>;
    type?: string;
  }>;
}): boolean {
  return (
    message.blocks?.some(
      (block) =>
        block.type === 'actions' &&
        block.elements?.some((el) => el.action_id === 'workspace_picker_open_modal'),
    ) ?? false
  );
}

function assertResult(result: NoWorkspaceChatResult): void {
  const failures: string[] = [];

  if (!result.matched.assistantReplied) {
    failures.push('assistant did not reply within timeout');
  }
  if (!result.matched.noWorkspacePickerShown) {
    failures.push(
      'workspace picker was shown — expected conversation to proceed without workspace',
    );
  }
  if (!result.matched.replyContainsMarker) {
    failures.push(`reply does not contain expected marker "CHAT_OK ${result.runId}"`);
  }

  if (failures.length > 0) {
    throw new Error(`Live no-workspace chat E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: NoWorkspaceChatResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'no-workspace-chat-result.json',
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
  id: 'no-workspace-chat',
  title: 'No-Workspace Chat',
  description:
    'Mention the bot with a general knowledge question and verify it replies without showing a workspace picker.',
  keywords: ['no-workspace', 'chat', 'general', 'picker'],
  run: main,
};

runDirectly(scenario);
