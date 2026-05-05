import './load-e2e-env.js';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { env } from '~/env/server.js';

import { createLiveApplication } from './live-application.js';
import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import { SlackApiClient } from './slack-api-client.js';

const EXPECTED_MIN_REPLY_MESSAGES = 2;

interface LongMessageSplitResult {
  botUserId: string;
  channelId: string;
  failureMessage?: string;
  matched: {
    allRepliesHaveBlocks: boolean;
    markerFound: boolean;
    multipleReplies: boolean;
  };
  passed: boolean;
  replies: Array<{
    blockCount: number;
    blockTypes: string[];
    textLength: number;
    ts: string;
  }>;
  rootMessageTs?: string;
  runId: string;
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the long message split E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error(
      'Live long message split E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.',
    );
  }

  const runId = randomUUID();
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();

  const result: LongMessageSplitResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    matched: {
      allRepliesHaveBlocks: false,
      markerFound: false,
      multipleReplies: false,
    },
    passed: false,
    replies: [],
    runId,
  };

  const application = createLiveApplication();
  let caughtError: unknown;

  try {
    await application.start();
    await delay(3_000);

    const sectionLines: string[] = [];
    for (let i = 1; i <= 20; i++) {
      sectionLines.push(`## 第${i}节 功能说明`);
      sectionLines.push('');
      sectionLines.push(`这是第${i}节的详细描述，包含**加粗内容**和_斜体内容_。`);
      sectionLines.push('');
      sectionLines.push('```typescript');
      sectionLines.push(`export function handle${i}(): void {`);
      sectionLines.push(`  console.log("处理第${i}个请求");`);
      sectionLines.push('}');
      sectionLines.push('```');
      sectionLines.push('');
      sectionLines.push(`- 步骤一：初始化第${i}模块`);
      sectionLines.push(`- 步骤二：执行第${i}操作`);
      sectionLines.push('');
    }

    const prompt = [
      `<@${botIdentity.user_id}> LONG_MSG_E2E ${runId}`,
      `Output exactly the following markdown as your reply. Do NOT wrap it in a code fence. Do NOT summarize or shorten it. Output all 20 sections. Do not use any tools.`,
      '',
      `SPLIT_OK ${runId}`,
      '',
      ...sectionLines,
    ].join('\n');

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

      const botReplies: typeof result.replies = [];
      let markerFound = false;

      for (const message of replies.messages ?? []) {
        if (!message.ts || message.ts === rootMessage.ts) continue;
        if (message.user === botIdentity.user_id || message.bot_id) {
          const blocks = message.blocks ?? [];
          const text = typeof message.text === 'string' ? message.text : '';
          if (text.includes(`SPLIT_OK ${runId}`)) {
            markerFound = true;
          }
          botReplies.push({
            blockCount: blocks.length,
            blockTypes: [...new Set(blocks.map((b) => b.type).filter(Boolean) as string[])],
            textLength: text.length,
            ts: message.ts,
          });
        }
      }

      if (markerFound && botReplies.length >= EXPECTED_MIN_REPLY_MESSAGES) {
        result.replies = botReplies;
        result.matched.markerFound = true;
        result.matched.multipleReplies = botReplies.length >= EXPECTED_MIN_REPLY_MESSAGES;
        result.matched.allRepliesHaveBlocks = botReplies.every((r) => r.blockCount > 0);
        break;
      }

      if (markerFound) {
        result.matched.markerFound = true;
        result.replies = botReplies;
      }

      await delay(3_000);
    }

    await writeResult(result);
    assertResult(result);
    result.passed = true;
    await writeResult(result);

    console.info('Live long message split E2E passed.');
    console.info('Root thread: %s', result.rootMessageTs);
    console.info('Bot replies: %d messages', result.replies.length);
    for (const reply of result.replies) {
      console.info(
        '  ts=%s blocks=%d types=[%s] text=%d chars',
        reply.ts,
        reply.blockCount,
        reply.blockTypes.join(', '),
        reply.textLength,
      );
    }
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

function assertResult(result: LongMessageSplitResult): void {
  const failures: string[] = [];

  if (!result.matched.markerFound) {
    failures.push('marker SPLIT_OK not found in any reply');
  }
  if (!result.matched.multipleReplies) {
    failures.push(
      `expected at least ${EXPECTED_MIN_REPLY_MESSAGES} reply messages (long content should be split), got ${result.replies.length}`,
    );
  }
  if (!result.matched.allRepliesHaveBlocks) {
    const noBlocks = result.replies.filter((r) => r.blockCount === 0);
    failures.push(
      `${noBlocks.length} reply message(s) have no blocks — splitBlocksWithText may not be working`,
    );
  }

  if (failures.length > 0) {
    throw new Error(`Live long message split E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: LongMessageSplitResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'long-message-split-result.json',
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
  id: 'long-message-split',
  title: 'Long Message Split',
  description:
    'Send a prompt that produces a long markdown response (20 sections with headings, code, lists) and verify the bot splits it into multiple Slack messages, each with rich text blocks.',
  keywords: ['long', 'split', 'blocks', 'truncation', 'rich-text', 'cjk'],
  run: main,
};

runDirectly(scenario);
