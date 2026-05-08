import './load-e2e-env.js';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { createApplication } from '~/application.js';
import { env } from '~/env/server.js';

import { applyLiveE2EDatabaseMigrations } from './db-migrations.js';
import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import {
  SlackApiClient,
  type SlackConversationRepliesResponse,
  type SlackPostedMessageResponse,
} from './slack-api-client.js';

type SlackReplyMessage = NonNullable<SlackConversationRepliesResponse['messages']>[number];
type SlackReplyBlock = NonNullable<SlackReplyMessage['blocks']>[number];

interface RealTaskPlanBlockResult {
  assistantReplyBlocks?: unknown[];
  assistantReplyText?: string;
  assistantReplyTs?: string;
  botUserId: string;
  channelId: string;
  failureMessage?: string;
  matched: {
    assistantReplied: boolean;
    finalReplyHasNoPlanBlock: boolean;
    progressPlanBlockObserved: boolean;
    progressPlanBlockRetainedAfterFinal: boolean;
    progressTaskCardObserved: boolean;
    replyContainsMarker: boolean;
  };
  passed: boolean;
  planBlockSamples: unknown[];
  progressMessageText?: string;
  progressMessageTs?: string;
  rootMessageTs?: string;
  runId: string;
  targetRepo: string;
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the real-task plan block E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error(
      'Live real-task plan block E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.',
    );
  }

  const runId = randomUUID();
  const dbPath = e2ePath(`real-task-plan-block-${runId}.db`);
  const a2aDbPath = e2ePath(`real-task-plan-block-a2a-${runId}.db`);
  const targetRepo = process.env.SLACK_E2E_TARGET_REPO?.trim() || 'slack-cc-bot';
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();

  const result: RealTaskPlanBlockResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    matched: {
      assistantReplied: false,
      finalReplyHasNoPlanBlock: false,
      progressPlanBlockObserved: false,
      progressPlanBlockRetainedAfterFinal: false,
      progressTaskCardObserved: false,
      replyContainsMarker: false,
    },
    passed: false,
    planBlockSamples: [],
    runId,
    targetRepo,
  };

  applyLiveE2EDatabaseMigrations(dbPath);
  const application = createApplication({
    a2aCoordinatorDbPath: a2aDbPath,
    defaultProviderId: 'codex-cli',
    sessionDbPath: dbPath,
    skipManifestSync: true,
  });
  let caughtError: unknown;

  try {
    const slowCommand = `node -e "setTimeout(()=>console.log('REAL_TASK_PLAN_BLOCK_COMMAND_DONE ${runId}'), 12000)"`;
    const prompt = [
      `REAL_TASK_PLAN_BLOCK_E2E ${runId}`,
      `Use repository ${targetRepo} for this read-only verification.`,
      `First run exactly this shell command: ${slowCommand}`,
      'Then run exactly this shell command: git status --short',
      'Do not edit files.',
      `After both commands finish, send a final concise text summary in exactly this form: "REAL_TASK_PLAN_BLOCK_OK ${runId} summary: commands completed".`,
    ].join(' ');

    const rootMessage = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: prompt,
      unfurl_links: false,
      unfurl_media: false,
    });
    result.rootMessageTs = rootMessage.ts;
    console.info('Posted root message: %s', rootMessage.ts);

    const dispatchPromise = application.dispatchThreadConversation({
      addAcknowledgementReaction: false,
      agentProviderOverride: 'codex-cli',
      channelId: env.SLACK_E2E_CHANNEL_ID,
      currentBotUserId: botIdentity.user_id,
      currentBotUserName: botIdentity.user,
      forceNewSession: true,
      logLabel: 'real-task-plan-block live E2E',
      messageTs: rootMessage.ts,
      rootMessageTs: rootMessage.ts,
      text: prompt,
      userId: botIdentity.user_id,
    });

    const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const replies = await botClient.conversationReplies({
        channel: env.SLACK_E2E_CHANNEL_ID,
        inclusive: true,
        limit: 50,
        ts: rootMessage.ts,
      });

      inspectReplies(replies, rootMessage, result);

      if (
        result.matched.assistantReplied &&
        result.matched.progressPlanBlockObserved &&
        result.matched.progressTaskCardObserved
      ) {
        break;
      }

      await delay(1_500);
    }

    await dispatchPromise;
    const finalReplies = await botClient.conversationReplies({
      channel: env.SLACK_E2E_CHANNEL_ID,
      inclusive: true,
      limit: 50,
      ts: rootMessage.ts,
    });
    inspectReplies(finalReplies, rootMessage, result);
    result.matched.progressPlanBlockRetainedAfterFinal = hasRetainedProgressPlanBlock(
      finalReplies,
      result,
    );

    await writeResult(result);
    assertResult(result);
    result.passed = true;
    await writeResult(result);

    console.info('Live real-task plan block E2E passed.');
    console.info('Root thread: %s', result.rootMessageTs);
    console.info('Progress message: %s', result.progressMessageTs);
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

function inspectReplies(
  replies: SlackConversationRepliesResponse,
  rootMessage: SlackPostedMessageResponse,
  result: RealTaskPlanBlockResult,
): void {
  for (const message of replies.messages ?? []) {
    if (!message.ts || message.ts === rootMessage.ts) continue;

    const planBlocks = findPlanBlocks(message.blocks);
    if (
      planBlocks.length > 0 &&
      !message.text?.includes(`REAL_TASK_PLAN_BLOCK_OK ${result.runId}`)
    ) {
      result.progressMessageTs = message.ts;
      if (message.text) {
        result.progressMessageText = message.text;
      }
      result.matched.progressPlanBlockObserved = true;
      result.planBlockSamples = planBlocks.slice(0, 3);
      result.matched.progressTaskCardObserved ||= planBlocks.some(hasTaskCard);
    }

    const text = typeof message.text === 'string' ? message.text : '';
    if (!text.includes(`REAL_TASK_PLAN_BLOCK_OK ${result.runId}`)) {
      continue;
    }

    result.assistantReplyText = text;
    result.assistantReplyTs = message.ts;
    result.assistantReplyBlocks = message.blocks ?? [];
    result.matched.assistantReplied = true;
    result.matched.replyContainsMarker = true;
    result.matched.finalReplyHasNoPlanBlock = findPlanBlocks(message.blocks).length === 0;
  }
}

function findPlanBlocks(blocks: SlackReplyMessage['blocks']): SlackReplyBlock[] {
  return (blocks ?? []).filter((block) => block.type === 'plan');
}

function hasTaskCard(block: unknown): boolean {
  if (!block || typeof block !== 'object') {
    return false;
  }

  const tasks = (block as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) {
    return false;
  }

  return tasks.some(
    (task) =>
      task &&
      typeof task === 'object' &&
      typeof (task as { task_id?: unknown }).task_id === 'string' &&
      typeof (task as { title?: unknown }).title === 'string' &&
      typeof (task as { status?: unknown }).status === 'string',
  );
}

function hasRetainedProgressPlanBlock(
  replies: SlackConversationRepliesResponse,
  result: RealTaskPlanBlockResult,
): boolean {
  if (!result.progressMessageTs) {
    return false;
  }

  const progressMessage = (replies.messages ?? []).find(
    (message) => message.ts === result.progressMessageTs,
  );
  if (!progressMessage) {
    return false;
  }

  const planBlocks = findPlanBlocks(progressMessage.blocks);
  return planBlocks.some(hasTaskCard);
}

function assertResult(result: RealTaskPlanBlockResult): void {
  const failures: string[] = [];

  if (!result.matched.progressPlanBlockObserved) {
    failures.push('no plan block was observed on an in-flight progress message');
  }
  if (!result.matched.progressTaskCardObserved) {
    failures.push('progress plan block did not contain task cards');
  }
  if (!result.matched.progressPlanBlockRetainedAfterFinal) {
    failures.push('progress plan block was not retained after the final summary');
  }
  if (!result.matched.assistantReplied) {
    failures.push('assistant did not send the final summary within timeout');
  }
  if (!result.matched.replyContainsMarker) {
    failures.push(`final summary did not contain REAL_TASK_PLAN_BLOCK_OK ${result.runId}`);
  }
  if (!result.matched.finalReplyHasNoPlanBlock) {
    failures.push('final summary reply contains a plan block; expected text/rich_text only');
  }

  if (failures.length > 0) {
    throw new Error(`Live real-task plan block E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: RealTaskPlanBlockResult): Promise<void> {
  const absolutePath = e2ePath('real-task-plan-block-result.json');
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

function e2ePath(fileName: string): string {
  return path.resolve(process.cwd(), env.SLACK_E2E_RESULT_PATH.replace(/result\.json$/, fileName));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export const scenario: LiveE2EScenario = {
  id: 'real-task-plan-block',
  title: 'Real Task Plan Block',
  description:
    'Run a real Codex Slack task and verify in-flight progress uses plan task cards while the final summary remains a normal text reply.',
  keywords: ['real-task', 'plan-block', 'codex', 'progress', 'final-summary', 'task-card'],
  run: main,
};

runDirectly(scenario);
