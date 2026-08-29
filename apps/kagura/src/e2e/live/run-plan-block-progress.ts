import './load-e2e-env.js';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { env } from '~/env/server.js';
import type { AppLogger } from '~/logger/index.js';
import { SlackRenderer } from '~/slack/render/slack-renderer.js';
import type { SlackWebClientLike } from '~/slack/types.js';

import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import {
  SlackApiClient,
  type SlackConversationRepliesResponse,
  type SlackPostedMessageResponse,
} from './slack-api-client.js';

type SlackReplyMessage = NonNullable<SlackConversationRepliesResponse['messages']>[number];
type SlackReplyBlock = NonNullable<SlackReplyMessage['blocks']>[number];

interface PlanBlockProgressResult {
  anchorMessageTs?: string;
  botUserId: string;
  channelId: string;
  failureMessage?: string;
  matched: {
    anchorPosted: boolean;
    planBlockObserved: boolean;
    progressPosted: boolean;
    progressUpdated: boolean;
    taskCardObserved: boolean;
  };
  passed: boolean;
  planBlockSamples: unknown[];
  progressMessageText?: string;
  progressMessageTs?: string;
  runId: string;
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the plan-block progress E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error(
      'Live plan-block progress E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.',
    );
  }

  const runId = randomUUID();
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();
  const renderer = new SlackRenderer(createLogger());
  const slackClient = createRendererSlackClient(botClient);

  const result: PlanBlockProgressResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    matched: {
      anchorPosted: false,
      planBlockObserved: false,
      progressPosted: false,
      progressUpdated: false,
      taskCardObserved: false,
    },
    passed: false,
    planBlockSamples: [],
    runId,
  };

  let caughtError: unknown;

  try {
    const anchorMessage = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: `PLAN_BLOCK_PROGRESS_ANCHOR ${runId}`,
      unfurl_links: false,
      unfurl_media: false,
    });
    result.anchorMessageTs = anchorMessage.ts;
    result.matched.anchorPosted = true;
    console.info('Posted anchor message: %s', anchorMessage.ts);

    const progressTs = await renderer.upsertThreadProgressMessage(
      slackClient,
      env.SLACK_E2E_CHANNEL_ID,
      anchorMessage.ts,
      {
        clear: false,
        status: 'Running plan block live check...',
        tasks: [
          {
            type: 'task-update',
            taskId: `plan-start-${runId}`,
            title: 'Start plan block live check',
            status: 'in_progress',
            details: `PLAN_BLOCK_PROGRESS_DETAIL ${runId}`,
          },
        ],
        threadTs: anchorMessage.ts,
      },
    );
    result.matched.progressPosted = Boolean(progressTs);

    if (!progressTs) {
      throw new Error('SlackRenderer did not return a progress message ts.');
    }
    result.progressMessageTs = progressTs;

    await renderer.upsertThreadProgressMessage(
      slackClient,
      env.SLACK_E2E_CHANNEL_ID,
      anchorMessage.ts,
      {
        clear: false,
        status: 'Completing plan block live check...',
        tasks: [
          {
            type: 'task-update',
            taskId: `plan-start-${runId}`,
            title: 'Start plan block live check',
            status: 'complete',
            output: `PLAN_BLOCK_PROGRESS_OUTPUT ${runId}`,
          },
          {
            type: 'task-update',
            taskId: `plan-finish-${runId}`,
            title: 'Finish plan block live check',
            status: 'in_progress',
            details: 'Verifying Slack returned the plan block.',
          },
        ],
        threadTs: anchorMessage.ts,
      },
      progressTs,
    );
    result.matched.progressUpdated = true;

    const deadline = Date.now() + Math.min(env.SLACK_E2E_TIMEOUT_MS, 30_000);
    while (Date.now() < deadline) {
      const replies = await botClient.conversationReplies({
        channel: env.SLACK_E2E_CHANNEL_ID,
        inclusive: true,
        limit: 20,
        ts: anchorMessage.ts,
      });

      inspectReplies(replies, anchorMessage, result);
      if (result.matched.planBlockObserved && result.matched.taskCardObserved) {
        break;
      }

      await delay(1_500);
    }

    await writeResult(result);
    assertResult(result);
    result.passed = true;
    await writeResult(result);

    console.info('Live plan-block progress E2E passed.');
    console.info('Anchor message: %s', result.anchorMessageTs);
    console.info('Progress message: %s', result.progressMessageTs);
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error);
    caughtError = error;
  } finally {
    await writeResult(result).catch((error) => {
      console.error('Failed to persist result:', error);
    });
  }

  if (caughtError) {
    throw caughtError;
  }
}

function inspectReplies(
  replies: SlackConversationRepliesResponse,
  anchorMessage: SlackPostedMessageResponse,
  result: PlanBlockProgressResult,
): void {
  for (const message of replies.messages ?? []) {
    if (!message.ts || message.ts === anchorMessage.ts) continue;
    if (result.progressMessageTs && message.ts !== result.progressMessageTs) continue;

    const planBlocks = findPlanBlocks(message.blocks);
    if (planBlocks.length === 0) {
      continue;
    }

    if (message.text) {
      result.progressMessageText = message.text;
    }
    result.matched.planBlockObserved = true;
    result.planBlockSamples = planBlocks.slice(0, 3);
    result.matched.taskCardObserved = planBlocks.some(hasTaskCard);
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

function assertResult(result: PlanBlockProgressResult): void {
  const failures: string[] = [];

  if (!result.matched.anchorPosted) {
    failures.push('anchor message was not posted');
  }
  if (!result.matched.progressPosted) {
    failures.push('progress message was not posted');
  }
  if (!result.matched.progressUpdated) {
    failures.push('progress message was not updated');
  }
  if (!result.matched.planBlockObserved) {
    failures.push('no Slack plan block was observed on the progress message');
  }
  if (!result.matched.taskCardObserved) {
    failures.push('plan block was observed, but it did not contain task cards');
  }

  if (failures.length > 0) {
    throw new Error(`Live plan-block progress E2E failed: ${failures.join('; ')}`);
  }
}

function createRendererSlackClient(botClient: SlackApiClient): SlackWebClientLike {
  return {
    apiCall: async () => ({}),
    chat: {
      delete: async () => ({}),
      postMessage: (args) => {
        const payload = {
          channel: args.channel,
          text: args.text,
          unfurl_links: false,
          unfurl_media: false,
          ...(args.thread_ts ? { thread_ts: args.thread_ts } : {}),
          ...(args.blocks ? { blocks: args.blocks } : {}),
        };
        return botClient.postMessage(payload);
      },
      update: (args) => botClient.updateMessage(args),
    },
    conversations: {
      replies: (args) => botClient.conversationReplies(args),
    },
    files: {
      uploadV2: async () => ({ files: [] }),
    },
    reactions: {
      add: async () => ({}),
      remove: async () => ({}),
    },
    views: {
      open: async () => ({}),
      publish: async () => ({}),
    },
  };
}

function createLogger(): AppLogger {
  const logger = {
    debug: () => {},
    error: () => {},
    fatal: () => {},
    info: () => {},
    trace: () => {},
    warn: () => {},
    withTag: () => logger,
  };
  return logger as unknown as AppLogger;
}

async function writeResult(result: PlanBlockProgressResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'plan-block-progress-result.json',
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
  id: 'plan-block-progress',
  title: 'Plan Block Progress',
  description:
    'Post a live Slack progress message through SlackRenderer and verify it uses a native plan block with task cards.',
  keywords: ['plan', 'plan-block', 'progress', 'renderer', 'task-card', 'blocks'],
  run: main,
};

runDirectly(scenario);
