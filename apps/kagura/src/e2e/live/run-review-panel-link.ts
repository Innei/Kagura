import './load-e2e-env.js';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { createApplication } from '~/application.js';
import { env } from '~/env/server.js';

import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import { SlackApiClient, type SlackConversationRepliesResponse } from './slack-api-client.js';

const MARKER_PREFIX = 'REVIEW_PANEL_LINK_OK';

type SlackReplyMessage = NonNullable<SlackConversationRepliesResponse['messages']>[number];

interface ReviewPanelLinkResult {
  apiStatus?: number;
  botUserId: string;
  channelId: string;
  executionId?: string;
  failureMessage?: string;
  matched: {
    apiReachable: boolean;
    assistantReplied: boolean;
    reviewLinkMatchesBaseUrl: boolean;
    reviewLinkObserved: boolean;
    reviewPageReachable: boolean;
    sessionMatchesThread: boolean;
  };
  pageStatus?: number;
  passed: boolean;
  reviewUrl?: string;
  rootMessageTs?: string;
  runId: string;
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the review-panel-link E2E.');
  }

  if (!env.KAGURA_REVIEW_PANEL_ENABLED) {
    throw new Error('Set KAGURA_REVIEW_PANEL_ENABLED=true before running review-panel-link.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error('Live E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.');
  }

  const runId = randomUUID();
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();

  const result: ReviewPanelLinkResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    matched: {
      apiReachable: false,
      assistantReplied: false,
      reviewLinkMatchesBaseUrl: false,
      reviewLinkObserved: false,
      reviewPageReachable: false,
      sessionMatchesThread: false,
    },
    passed: false,
    runId,
  };

  const application = createApplication({ defaultProviderId: 'codex-cli' });
  let caughtError: unknown;

  try {
    await application.start();
    await delay(3_000);

    const rootMessage = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: [
        `<@${botIdentity.user_id}> REVIEW_PANEL_LINK_E2E ${runId}`,
        `Use workspace path ${process.cwd()} for this task.`,
        `Reply with exactly one line: "${MARKER_PREFIX} ${runId}".`,
        'Do not edit files and do not use code fences.',
      ].join(' '),
      unfurl_links: false,
      unfurl_media: false,
    });
    result.rootMessageTs = rootMessage.ts;
    console.info('[e2e] Posted root message: %s', rootMessage.ts);

    const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const replies = await botClient.conversationReplies({
        channel: env.SLACK_E2E_CHANNEL_ID,
        inclusive: true,
        limit: 100,
        ts: rootMessage.ts,
      });

      if (findAssistantReply(replies, rootMessage.ts, botIdentity.user_id, runId)) {
        result.matched.assistantReplied = true;
      }

      const reviewUrl = findReviewUrl(replies, rootMessage.ts, botIdentity.user_id);
      if (reviewUrl) {
        const executionId = extractExecutionId(reviewUrl);
        result.reviewUrl = reviewUrl;
        if (executionId) {
          result.executionId = executionId;
        }
        result.matched.reviewLinkObserved = true;
        result.matched.reviewLinkMatchesBaseUrl = reviewUrl.startsWith(
          `${env.KAGURA_REVIEW_PANEL_BASE_URL.replace(/\/$/, '')}/reviews/`,
        );
      }

      if (result.matched.assistantReplied && result.matched.reviewLinkObserved) {
        break;
      }

      await delay(2_500);
    }

    if (result.reviewUrl && result.executionId) {
      await verifyReviewPanelHttp(result);
    }

    await writeResult(result);
    assertResult(result);
    result.passed = true;
    await writeResult(result);

    console.info('[e2e] Review panel link E2E passed.');
    console.info('[e2e] Root thread: %s', result.rootMessageTs);
    console.info('[e2e] Review URL: %s', result.reviewUrl);
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error);
    caughtError = error;
  } finally {
    await writeResult(result).catch((error) => {
      console.error('Failed to persist review-panel-link result:', error);
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
  botUserId: string,
  runId: string,
): SlackReplyMessage | undefined {
  return replies.messages?.find((message) => {
    if (!message.ts || message.ts === rootTs) return false;
    if (!isBotAuthoredMessage(message, botUserId)) return false;
    return typeof message.text === 'string' && message.text.includes(`${MARKER_PREFIX} ${runId}`);
  });
}

function findReviewUrl(
  replies: SlackConversationRepliesResponse,
  rootTs: string,
  botUserId: string,
): string | undefined {
  for (const message of replies.messages ?? []) {
    if (!message.ts || message.ts === rootTs) continue;
    if (!isBotAuthoredMessage(message, botUserId)) continue;

    const fromText =
      typeof message.text === 'string'
        ? /Review diff:\s+(https?:\/\/\S+)/.exec(message.text)
        : null;
    if (fromText?.[1]) {
      return fromText[1];
    }

    for (const block of message.blocks ?? []) {
      for (const element of block.elements ?? []) {
        const url = typeof element.url === 'string' ? element.url : undefined;
        if (url?.includes('/reviews/')) {
          return url;
        }
      }
    }
  }

  return undefined;
}

async function verifyReviewPanelHttp(result: ReviewPanelLinkResult): Promise<void> {
  if (!result.reviewUrl || !result.executionId || !result.rootMessageTs) return;

  const pageResponse = await fetch(result.reviewUrl);
  result.pageStatus = pageResponse.status;
  result.matched.reviewPageReachable = pageResponse.ok;

  const sessionUrl = new URL(
    `/api/reviews/${encodeURIComponent(result.executionId)}`,
    env.KAGURA_REVIEW_PANEL_BASE_URL,
  );
  const apiResponse = await fetch(sessionUrl);
  result.apiStatus = apiResponse.status;
  result.matched.apiReachable = apiResponse.ok;
  if (!apiResponse.ok) return;

  const session = (await apiResponse.json()) as { threadTs?: unknown };
  result.matched.sessionMatchesThread = session.threadTs === result.rootMessageTs;
}

function extractExecutionId(reviewUrl: string): string | undefined {
  const pathname = new URL(reviewUrl).pathname;
  const match = /^\/reviews\/([^/]+)$/.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

function isBotAuthoredMessage(message: SlackReplyMessage, botUserId: string): boolean {
  return message.user === botUserId || Boolean(message.bot_id);
}

async function writeResult(result: ReviewPanelLinkResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'review-panel-link-result.json',
  );
  const absolutePath = path.resolve(process.cwd(), resultPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

function assertResult(result: ReviewPanelLinkResult): void {
  const failures: string[] = [];
  if (!result.matched.assistantReplied) failures.push('assistant reply marker was not observed');
  if (!result.matched.reviewLinkObserved) failures.push('review panel link was not posted');
  if (!result.matched.reviewLinkMatchesBaseUrl) {
    failures.push('review panel link did not use configured base URL');
  }
  if (!result.matched.reviewPageReachable) {
    failures.push(`review panel page was not reachable (status=${result.pageStatus ?? 'none'})`);
  }
  if (!result.matched.apiReachable) {
    failures.push(`review panel API was not reachable (status=${result.apiStatus ?? 'none'})`);
  }
  if (!result.matched.sessionMatchesThread) {
    failures.push('review panel API session did not match the Slack root thread');
  }

  if (failures.length > 0) {
    throw new Error(`E2E failed: ${failures.join('; ')}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export const scenario: LiveE2EScenario = {
  id: 'review-panel-link',
  provider: {
    kind: 'specific',
    providerId: 'codex-cli',
    reason: 'Requires Codex workspace-bound code review output.',
  },
  title: 'Review Panel Link',
  description: 'Verifies Slack posts a review panel link and the public panel/API are reachable.',
  keywords: ['review', 'panel', 'webui', 'cloudflare', 'argo'],
  run: main,
};

runDirectly(scenario);
