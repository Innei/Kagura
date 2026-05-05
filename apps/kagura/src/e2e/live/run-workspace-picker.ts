import './load-e2e-env.js';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { env } from '~/env/server.js';
import { decodeWorkspacePickerButtonValue } from '~/slack/interactions/workspace-picker-payload.js';

import { createLiveApplication } from './live-application.js';
import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import { SlackApiClient, type SlackConversationRepliesResponse } from './slack-api-client.js';
import { buildWorkspacePickerTempRepoPaths } from './workspace-picker-paths.js';

interface WorkspacePickerLiveResult {
  botUserId: string;
  channelId: string;
  failureMessage?: string | undefined;
  matched: {
    actionsBlockObserved: boolean;
    buttonPayloadValid: boolean;
    greenButtonObserved: boolean;
    interactiveReplyObserved: boolean;
    sectionTextObserved: boolean;
  };
  passed: boolean;
  replyBlocks?: unknown[] | undefined;
  replyText?: string | undefined;
  replyTs?: string | undefined;
  rootMessageTs?: string | undefined;
  runId: string;
  tempRepoName: string;
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the live workspace picker E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error(
      'Live workspace picker E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.',
    );
  }

  const runId = randomUUID();
  const { tempParentA, tempParentB, tempRepo1, tempRepo2, tempRepoName } =
    buildWorkspacePickerTempRepoPaths(env.REPO_ROOT_DIR, runId);

  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();

  const result: WorkspacePickerLiveResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    matched: {
      actionsBlockObserved: false,
      buttonPayloadValid: false,
      greenButtonObserved: false,
      interactiveReplyObserved: false,
      sectionTextObserved: false,
    },
    passed: false,
    runId,
    tempRepoName,
  };

  await fs.mkdir(path.join(tempRepo1, '.git'), { recursive: true });
  await fs.mkdir(path.join(tempRepo2, '.git'), { recursive: true });

  const application = createLiveApplication();
  let caughtError: unknown;

  try {
    await application.start();
    await delay(3_000);

    const prompt = [
      `<@${botIdentity.user_id}> LIVE_E2E_PICKER ${runId}`,
      `Please work on ${tempRepoName}.`,
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

      const interactiveReply = findInteractiveReply(replies, rootMessage.ts);
      if (interactiveReply) {
        result.replyTs = interactiveReply.ts;
        result.replyText = interactiveReply.text;
        result.replyBlocks = interactiveReply.blocks;
        result.matched.interactiveReplyObserved = true;

        applyBlockAssertions(interactiveReply, prompt, result);
      }

      if (allAssertionsSatisfied(result)) {
        break;
      }

      await delay(2_500);
    }

    await writeResult(result);
    assertResult(result);
    result.passed = true;
    await writeResult(result);

    console.info('Live workspace picker E2E passed.');
    console.info('Root thread: %s', result.rootMessageTs);
    console.info('Interactive reply: %s', result.replyTs);
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
    await fs.rm(tempParentA, { recursive: true, force: true }).catch(() => {});
    await fs.rm(tempParentB, { recursive: true, force: true }).catch(() => {});
  }

  if (caughtError) {
    throw caughtError;
  }
}

function findInteractiveReply(
  replies: SlackConversationRepliesResponse,
  rootTs: string,
):
  | {
      blocks?: Array<{
        block_id?: string;
        elements?: Array<Record<string, unknown>>;
        type?: string;
      }>;
      text?: string;
      ts?: string;
    }
  | undefined {
  return replies.messages?.find((message) => {
    if (!message.ts || message.ts === rootTs) {
      return false;
    }

    return message.blocks?.some((block) => block.type === 'actions');
  });
}

function applyBlockAssertions(
  reply: {
    blocks?: Array<{ block_id?: string; elements?: Array<Record<string, unknown>>; type?: string }>;
    text?: string;
  },
  originalPrompt: string,
  result: WorkspacePickerLiveResult,
): void {
  if (!reply.blocks) {
    return;
  }

  const sectionBlock = reply.blocks.find((block) => block.type === 'section');
  if (sectionBlock) {
    result.matched.sectionTextObserved = true;
  }

  const actionsBlock = reply.blocks.find((block) => block.type === 'actions');
  if (!actionsBlock) {
    return;
  }

  result.matched.actionsBlockObserved = true;

  const elements = actionsBlock.elements ?? [];
  const greenButton = elements.find(
    (element) =>
      element.type === 'button' &&
      element.action_id === 'workspace_picker_open_modal' &&
      element.style === 'primary',
  );
  if (greenButton) {
    result.matched.greenButtonObserved = true;

    const decoded = decodeWorkspacePickerButtonValue(
      typeof greenButton.value === 'string' ? greenButton.value : undefined,
    );
    if (decoded && originalPrompt.startsWith(decoded.slice(0, 20))) {
      result.matched.buttonPayloadValid = true;
    }
  }
}

function allAssertionsSatisfied(result: WorkspacePickerLiveResult): boolean {
  return (
    result.matched.interactiveReplyObserved &&
    result.matched.actionsBlockObserved &&
    result.matched.greenButtonObserved &&
    result.matched.buttonPayloadValid &&
    result.matched.sectionTextObserved
  );
}

function assertResult(result: WorkspacePickerLiveResult): void {
  const failures: string[] = [];

  if (!result.matched.interactiveReplyObserved) {
    failures.push('interactive reply with blocks not observed');
  }
  if (!result.matched.sectionTextObserved) {
    failures.push('section text block not observed');
  }
  if (!result.matched.actionsBlockObserved) {
    failures.push('actions block not observed');
  }
  if (!result.matched.greenButtonObserved) {
    failures.push('green "Choose Workspace" button not observed');
  }
  if (!result.matched.buttonPayloadValid) {
    failures.push('button value does not contain encoded original message text');
  }

  if (failures.length > 0) {
    throw new Error(`Live workspace picker E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: WorkspacePickerLiveResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'workspace-picker-result.json',
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
  id: 'workspace-picker',
  title: 'Workspace Picker',
  description:
    'Mention the bot with an ambiguous repo name and verify it shows the interactive workspace picker with correct button payload.',
  keywords: ['workspace', 'picker', 'interactive', 'modal', 'button', 'ambiguous'],
  run: main,
};

runDirectly(scenario);
