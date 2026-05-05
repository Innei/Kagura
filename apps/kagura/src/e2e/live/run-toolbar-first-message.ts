import './load-e2e-env.js';

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { env } from '~/env/server.js';

import { createLiveApplication } from './live-application.js';
import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import { SlackApiClient, type SlackConversationRepliesResponse } from './slack-api-client.js';

const FIRST_MARKER_PREFIX = 'TOOLBAR_FIRST_OK';

interface ToolbarFirstMessageReply {
  contextTexts: string[];
  text: string;
  ts: string;
}

interface ToolbarFirstMessageResult {
  botUserId: string;
  channelId: string;
  failureMessage?: string;
  firstReply?: ToolbarFirstMessageReply;
  matched: {
    firstReplyHasWorkspaceBranch: boolean;
    firstReplyHasNoToolHistory: boolean;
    firstReplyHasWorkspaceLabel: boolean;
    firstReplyObserved: boolean;
    secondReplyHasNoToolHistory: boolean;
    secondReplyHasNoWorkspaceLabel: boolean;
    secondReplyObserved: boolean;
  };
  passed: boolean;
  rootMessageTs?: string;
  runId: string;
  secondReply?: ToolbarFirstMessageReply;
  targetRepo: string;
  targetWorkspaceBranch?: string;
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the toolbar-first-message E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error(
      'Live toolbar-first-message E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.',
    );
  }

  const runId = randomUUID();
  const targetRepo = process.env.SLACK_E2E_TARGET_REPO?.trim() || 'kagura';
  const targetWorkspacePath = process.cwd();
  const targetWorkspaceBranch = resolveCurrentBranch(targetWorkspacePath);
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();

  const result: ToolbarFirstMessageResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    matched: {
      firstReplyHasWorkspaceBranch: false,
      firstReplyHasNoToolHistory: false,
      firstReplyHasWorkspaceLabel: false,
      firstReplyObserved: false,
      secondReplyHasNoToolHistory: false,
      secondReplyHasNoWorkspaceLabel: false,
      secondReplyObserved: false,
    },
    passed: false,
    runId,
    ...(targetWorkspaceBranch ? { targetWorkspaceBranch } : {}),
    targetRepo,
  };

  const application = createLiveApplication();
  let caughtError: unknown;

  try {
    await application.start();
    await delay(3_000);

    const prompt = [
      `<@${botIdentity.user_id}> [e2e:${runId}] ${targetWorkspacePath}`,
      `Use workspace path ${targetWorkspacePath} for this task.`,
      `Repository label: ${targetRepo}.`,
      'First, read package.json using a file-reading tool.',
      `Then send one assistant message with exactly: "${FIRST_MARKER_PREFIX} ${runId}".`,
      'Do not wrap the marker in code fences.',
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
        limit: 100,
        ts: rootMessage.ts,
      });

      const firstReply = findReplyByMarker(
        replies,
        rootMessage.ts,
        botIdentity.user_id,
        `${FIRST_MARKER_PREFIX} ${runId}`,
      );
      if (firstReply) {
        result.firstReply = firstReply;
        result.matched.firstReplyObserved = true;
        result.matched.firstReplyHasWorkspaceLabel = hasWorkspaceLabelContext(
          firstReply.contextTexts,
        );
        result.matched.firstReplyHasWorkspaceBranch = hasWorkspaceBranchContext(
          firstReply.contextTexts,
          targetWorkspaceBranch,
        );
        result.matched.firstReplyHasNoToolHistory = !hasToolHistoryContext(firstReply.contextTexts);
      }

      if (result.matched.firstReplyObserved) {
        break;
      }

      await delay(2_500);
    }

    await writeResult(result);
    assertResult(result);
    result.passed = true;
    await writeResult(result);

    console.info('Live toolbar-first-message E2E passed.');
    console.info('Root thread: %s', result.rootMessageTs);
    console.info('First reply: %s', result.firstReply?.ts);
    console.info('Second reply: %s', result.secondReply?.ts);
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error);
    caughtError = error;
  } finally {
    await writeResult(result).catch((error) => {
      console.error('Failed to persist toolbar-first-message result:', error);
    });
    await application.stop().catch((error) => {
      console.error('Failed to stop application:', error);
    });
  }

  if (caughtError) {
    throw caughtError;
  }
}

function findReplyByMarker(
  replies: SlackConversationRepliesResponse,
  rootTs: string,
  botUserId: string,
  marker: string,
): ToolbarFirstMessageReply | undefined {
  const message = replies.messages?.find((candidate) => {
    if (!candidate.ts || candidate.ts === rootTs) return false;
    if (!(candidate.user === botUserId || candidate.bot_id)) return false;
    return typeof candidate.text === 'string' && candidate.text.includes(marker);
  });

  if (!message?.ts || typeof message.text !== 'string') {
    return undefined;
  }

  return {
    contextTexts: extractContextTexts(message.blocks),
    text: message.text,
    ts: message.ts,
  };
}

function extractContextTexts(
  blocks?: Array<{ elements?: Array<Record<string, unknown>>; type?: string }>,
): string[] {
  if (!blocks) return [];

  const texts: string[] = [];
  for (const block of blocks) {
    if (block.type !== 'context') continue;
    for (const element of block.elements ?? []) {
      if (typeof element.text === 'string' && element.text.trim().length > 0) {
        texts.push(element.text);
      }
    }
  }

  return texts;
}

function hasWorkspaceLabelContext(contextTexts: readonly string[]): boolean {
  return contextTexts.some((text) => text.includes('Working in'));
}

function hasWorkspaceBranchContext(
  contextTexts: readonly string[],
  expectedBranch: string | undefined,
): boolean {
  if (!expectedBranch) {
    return true;
  }

  return contextTexts.some((text) => text.includes(`branch: ${expectedBranch}`));
}

function hasToolHistoryContext(contextTexts: readonly string[]): boolean {
  return contextTexts.some((text) => /\bx\d+\b/.test(text) && !text.includes('Working in'));
}

function assertResult(result: ToolbarFirstMessageResult): void {
  const failures: string[] = [];

  if (!result.matched.firstReplyObserved) {
    failures.push(`first marker "${FIRST_MARKER_PREFIX} ${result.runId}" was not observed`);
  }
  if (!result.matched.firstReplyHasWorkspaceLabel) {
    failures.push('first assistant reply does not contain a workspace label context block');
  }
  if (result.targetWorkspaceBranch && !result.matched.firstReplyHasWorkspaceBranch) {
    failures.push(
      `first assistant reply does not contain the current workspace branch (${result.targetWorkspaceBranch})`,
    );
  }
  if (!result.matched.firstReplyHasNoToolHistory) {
    failures.push('first assistant reply unexpectedly contains a tool history context block');
  }
  if (result.matched.secondReplyObserved && !result.matched.secondReplyHasNoWorkspaceLabel) {
    failures.push('second assistant reply unexpectedly repeated the workspace label context block');
  }
  if (result.matched.secondReplyObserved && !result.matched.secondReplyHasNoToolHistory) {
    failures.push('second assistant reply unexpectedly repeated the tool history context block');
  }

  if (failures.length > 0) {
    throw new Error(`Live toolbar-first-message E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: ToolbarFirstMessageResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'toolbar-first-message-result.json',
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

function resolveCurrentBranch(workspacePath: string): string | undefined {
  try {
    const branch = execFileSync('git', ['-C', workspacePath, 'branch', '--show-current'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    return branch || undefined;
  } catch {
    return undefined;
  }
}

export const scenario: LiveE2EScenario = {
  id: 'toolbar-first-message',
  title: 'Toolbar Only On First Assistant Message',
  description:
    'Verify that a live workspace-bound tool-use reply includes the workspace label without retaining tool-history toolbar text.',
  keywords: ['toolbar', 'workspace-label', 'tool-history', 'multi-message', 'cleanup'],
  run: main,
};

runDirectly(scenario);
