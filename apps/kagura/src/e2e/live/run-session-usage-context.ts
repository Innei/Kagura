import './load-e2e-env.js';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { env } from '~/env/server.js';

import { createLiveApplication } from './live-application.js';
import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import {
  SlackApiClient,
  type SlackConversationRepliesResponse,
  type SlackPostedMessageResponse,
} from './slack-api-client.js';

type SlackReplyMessage = NonNullable<SlackConversationRepliesResponse['messages']>[number];

interface SessionUsageContextResult {
  assistantReplyText?: string;
  assistantReplyTs?: string;
  botUserId: string;
  channelId: string;
  failureMessage?: string;
  matched: {
    assistantReplied: boolean;
    usageMessageAttachedToAssistant: boolean;
    usageMessageAfterAssistant: boolean;
    usageMessageHasContextBlock: boolean;
    usageMessageMatchesFormat: boolean;
    usageMessageObserved: boolean;
  };
  passed: boolean;
  rootMessageTs?: string;
  runId: string;
  usageContextTexts: string[];
  usageMessageText?: string;
  usageMessageTs?: string;
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the session-usage-context E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error('Live E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.');
  }

  const runId = randomUUID();
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();

  const result: SessionUsageContextResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    matched: {
      assistantReplied: false,
      usageMessageAttachedToAssistant: false,
      usageMessageAfterAssistant: false,
      usageMessageHasContextBlock: false,
      usageMessageMatchesFormat: false,
      usageMessageObserved: false,
    },
    passed: false,
    runId,
    usageContextTexts: [],
  };

  const application = createLiveApplication();
  let caughtError: unknown;

  try {
    await application.start();
    await delay(3_000);

    const rootMessage = await postPrompt(triggerClient, botIdentity.user_id, runId);
    result.rootMessageTs = rootMessage.ts;
    console.info('[e2e] Posted root message: %s', rootMessage.ts);

    const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const replies = await botClient.conversationReplies({
        channel: env.SLACK_E2E_CHANNEL_ID,
        inclusive: true,
        limit: 50,
        ts: rootMessage.ts,
      });

      const assistantReply = findAssistantReply(replies, rootMessage.ts, runId);
      if (assistantReply) {
        result.assistantReplyText = assistantReply.text;
        result.assistantReplyTs = assistantReply.ts;
        result.matched.assistantReplied = true;
      }

      if (assistantReply) {
        const usageMessage = findUsageMessage({
          assistantReplyTs: assistantReply.ts,
          botUserId: botIdentity.user_id,
          replies,
          rootTs: rootMessage.ts,
        });

        if (usageMessage) {
          result.usageMessageText = usageMessage.text;
          result.usageMessageTs = usageMessage.ts;
          result.usageContextTexts = usageMessage.contextTexts;
          result.matched.usageMessageObserved = true;
          result.matched.usageMessageAttachedToAssistant = usageMessage.ts === assistantReply.ts;
          result.matched.usageMessageAfterAssistant =
            usageMessage.ts === assistantReply.ts || isTsAfter(usageMessage.ts, assistantReply.ts);
          result.matched.usageMessageHasContextBlock = usageMessage.contextTexts.length > 0;
          result.matched.usageMessageMatchesFormat =
            isUsageSummaryText(usageMessage.text) ||
            usageMessage.contextTexts.some((text) => isUsageSummaryText(text));
        }
      }

      if (result.matched.assistantReplied && result.matched.usageMessageObserved) {
        break;
      }

      await delay(2_500);
    }

    await writeResult(result);
    assertResult(result);
    result.passed = true;
    await writeResult(result);

    console.info('[e2e] Session usage context E2E passed.');
    console.info('[e2e] Root thread: %s', result.rootMessageTs);
    console.info('[e2e] Assistant reply: %s', result.assistantReplyTs);
    console.info('[e2e] Usage context message: %s', result.usageMessageTs);
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error);
    caughtError = error;
  } finally {
    await writeResult(result).catch((error) => {
      console.error('Failed to persist session-usage-context result:', error);
    });
    await application.stop().catch((error) => {
      console.error('Failed to stop application:', error);
    });
  }

  if (caughtError) {
    throw caughtError;
  }
}

async function postPrompt(
  triggerClient: SlackApiClient,
  botUserId: string,
  runId: string,
): Promise<SlackPostedMessageResponse> {
  const prompt = [
    `<@${botUserId}> SESSION_USAGE_CONTEXT_E2E ${runId}`,
    `Reply with exactly one line: "USAGE_CONTEXT_OK ${runId} 8".`,
    'Do not use any file, search, or code tools unless absolutely required.',
  ].join(' ');

  return triggerClient.postMessage({
    channel: env.SLACK_E2E_CHANNEL_ID!,
    text: prompt,
    unfurl_links: false,
    unfurl_media: false,
  });
}

function findAssistantReply(
  replies: SlackConversationRepliesResponse,
  rootTs: string,
  runId: string,
): { text: string; ts: string } | undefined {
  for (const message of replies.messages ?? []) {
    if (!message.ts || message.ts === rootTs) continue;
    if (typeof message.text !== 'string') continue;
    if (!message.text.includes(`USAGE_CONTEXT_OK ${runId}`)) continue;
    return { text: message.text, ts: message.ts };
  }

  return undefined;
}

function findUsageMessage(input: {
  assistantReplyTs: string;
  botUserId: string;
  replies: SlackConversationRepliesResponse;
  rootTs: string;
}):
  | {
      contextTexts: string[];
      text: string;
      ts: string;
    }
  | undefined {
  for (const message of input.replies.messages ?? []) {
    if (!message.ts || message.ts === input.rootTs) continue;
    if (message.ts !== input.assistantReplyTs && !isTsAfter(message.ts, input.assistantReplyTs)) {
      continue;
    }
    if (!isBotAuthoredMessage(message, input.botUserId)) continue;

    const text = typeof message.text === 'string' ? message.text.trim() : '';
    const contextTexts = extractContextTexts(message.blocks);
    if (
      !isUsageSummaryText(text) &&
      !contextTexts.some((candidate) => isUsageSummaryText(candidate))
    ) {
      continue;
    }

    return {
      contextTexts,
      text,
      ts: message.ts,
    };
  }

  return undefined;
}

function isBotAuthoredMessage(message: SlackReplyMessage, botUserId: string): boolean {
  return message.user === botUserId || Boolean(message.bot_id);
}

function extractContextTexts(blocks: SlackReplyMessage['blocks']): string[] {
  const texts: string[] = [];

  for (const block of blocks ?? []) {
    if (block.type !== 'context') continue;
    for (const element of block.elements ?? []) {
      if (typeof element.text !== 'string') continue;
      const trimmed = element.text.trim();
      if (trimmed) {
        texts.push(trimmed);
      }
    }
  }

  return texts;
}

function isUsageSummaryText(text: string | undefined): boolean {
  if (!text) return false;

  const normalized = text.trim();
  return (
    /^\d+(?:\.\d+)?s\b/.test(normalized) &&
    /\bnon-cached in \+ out\b/.test(normalized) &&
    /\(\d+% cache\)/.test(normalized)
  );
}

function isTsAfter(candidateTs: string, referenceTs: string): boolean {
  return Number.parseFloat(candidateTs) > Number.parseFloat(referenceTs);
}

function assertResult(result: SessionUsageContextResult): void {
  const failures: string[] = [];

  if (!result.matched.assistantReplied) {
    failures.push('assistant did not emit the expected marker reply');
  }
  if (!result.matched.usageMessageObserved) {
    failures.push('session usage context was not observed on or after the assistant reply');
  }
  if (!result.matched.usageMessageAttachedToAssistant) {
    failures.push('session usage details were not attached to the assistant reply');
  }
  if (!result.matched.usageMessageAfterAssistant) {
    failures.push('session usage context did not appear on or after the assistant reply');
  }
  if (!result.matched.usageMessageHasContextBlock) {
    failures.push('session usage message does not include a Slack context block');
  }
  if (!result.matched.usageMessageMatchesFormat) {
    failures.push('session usage message does not match the expected duration/cost/token format');
  }

  if (failures.length > 0) {
    throw new Error(`Live session-usage-context E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: SessionUsageContextResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'session-usage-context-result.json',
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
  id: 'session-usage-context',
  title: 'Session Usage Context Stays With Reply',
  description:
    'Verify that a successful run attaches session usage and cost details to the assistant reply instead of posting a detached context message.',
  keywords: ['session', 'usage', 'context', 'cost', 'tokens', 'reply'],
  run: main,
};

runDirectly(scenario);
