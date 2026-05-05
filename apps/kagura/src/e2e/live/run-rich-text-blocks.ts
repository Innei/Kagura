import './load-e2e-env.js';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { env } from '~/env/server.js';

import { createLiveApplication } from './live-application.js';
import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import { SlackApiClient } from './slack-api-client.js';

interface RichTextBlocksResult {
  assistantReplyText?: string;
  assistantReplyTs?: string;
  blocks?: unknown[];
  botUserId: string;
  channelId: string;
  failureMessage?: string;
  matched: {
    assistantReplied: boolean;
    hasBlocks: boolean;
    hasRichTextOrSectionBlock: boolean;
    replyContainsMarker: boolean;
  };
  passed: boolean;
  rootMessageTs?: string;
  runId: string;
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the rich text blocks E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error(
      'Live rich text blocks E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.',
    );
  }

  const runId = randomUUID();
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();

  const result: RichTextBlocksResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    matched: {
      assistantReplied: false,
      hasBlocks: false,
      hasRichTextOrSectionBlock: false,
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
      `<@${botIdentity.user_id}> RICH_TEXT_E2E ${runId}`,
      `Reply with exactly this markdown (do NOT wrap it in a code fence, output it as your actual reply):`,
      `RICH_OK ${runId}`,
      ``,
      `**加粗文字** 和 _斜体文字_`,
      ``,
      '```ts\nconst 名前 = "太郎";\n```',
      ``,
      `- 第一项`,
      `- 第二项`,
      ``,
      `> 引用中文内容`,
      ``,
      `Do not add anything else. Do not use any tools. Just output the markdown above as your reply.`,
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

      for (const message of replies.messages ?? []) {
        if (!message.ts || message.ts === rootMessage.ts) continue;

        const text = typeof message.text === 'string' ? message.text : '';
        if (!text.includes(`RICH_OK ${runId}`)) continue;

        result.assistantReplyText = text;
        result.assistantReplyTs = message.ts;
        result.matched.assistantReplied = true;
        result.matched.replyContainsMarker = true;

        const blocks = message.blocks ?? [];
        result.blocks = blocks;
        result.matched.hasBlocks = blocks.length > 0;
        result.matched.hasRichTextOrSectionBlock = blocks.some(
          (block) => block.type === 'rich_text' || block.type === 'section',
        );
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

    console.info('Live rich text blocks E2E passed.');
    console.info('Root thread: %s', result.rootMessageTs);
    console.info('Assistant reply: %s', result.assistantReplyTs);
    console.info('Blocks found: %d', result.blocks?.length ?? 0);
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

function assertResult(result: RichTextBlocksResult): void {
  const failures: string[] = [];

  if (!result.matched.assistantReplied) {
    failures.push('assistant did not reply within timeout');
  }
  if (!result.matched.replyContainsMarker) {
    failures.push(`reply does not contain expected marker "RICH_OK ${result.runId}"`);
  }
  if (!result.matched.hasBlocks) {
    failures.push('reply has no blocks — expected rich text blocks from markdownToBlocks');
  }
  if (!result.matched.hasRichTextOrSectionBlock) {
    failures.push(
      'reply blocks do not contain rich_text or section type — markdown conversion may not be working',
    );
  }

  if (failures.length > 0) {
    throw new Error(`Live rich text blocks E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: RichTextBlocksResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'rich-text-blocks-result.json',
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
  id: 'rich-text-blocks',
  title: 'Rich Text Blocks',
  description:
    'Mention the bot with a request for markdown-formatted output and verify the reply uses Slack rich text blocks instead of plain text.',
  keywords: ['rich-text', 'blocks', 'markdown', 'formatting'],
  run: main,
};

runDirectly(scenario);
