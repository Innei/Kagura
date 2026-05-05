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
  type SlackMessageFile,
} from './slack-api-client.js';

/** 1×1 PNG, solid red — minimal payload for vision checks. */
const RED_SQUARE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

interface SlackImageSupportResult {
  assistantInboundReplyText?: string;
  assistantInboundReplyTs?: string;
  assistantOutboundMarkerReplyText?: string;
  assistantOutboundMarkerReplyTs?: string;
  botUserId: string;
  channelId: string;
  failureMessage?: string;
  inboundUpload?: {
    completeResponse?: { files?: Array<{ id?: string; title?: string }> };
    filename: string;
    sizeBytes: number;
  };
  matched: {
    inboundMarker: boolean;
    outboundImagePosted: boolean;
    outboundMarker: boolean;
  };
  outboundImageMessageSample?: {
    blocks?: unknown;
    files?: SlackMessageFile[];
    text?: string;
    ts?: string;
  };
  passed: boolean;
  rootMessageTs?: string;
  runId: string;
  targetRepo: string;
}

function isAssistantMessage(
  message: NonNullable<SlackConversationRepliesResponse['messages']>[number],
  botUserId: string,
): boolean {
  return message.user === botUserId || Boolean(message.bot_id);
}

function messageHasImagePayload(
  message: NonNullable<SlackConversationRepliesResponse['messages']>[number],
): boolean {
  const files = message.files ?? [];
  if (files.some((f) => typeof f.mimetype === 'string' && f.mimetype.startsWith('image/'))) {
    return true;
  }
  return (message.blocks ?? []).some((b) => b.type === 'image');
}

function messageTsAfter(messageTs: string, afterTs: string): boolean {
  return Number(messageTs) > Number(afterTs);
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the Slack image support E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error(
      'Live Slack image support E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.',
    );
  }

  const runId = randomUUID();
  const targetRepo = process.env.SLACK_E2E_TARGET_REPO?.trim() || 'kagura';
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();

  const redPng = Buffer.from(RED_SQUARE_PNG_BASE64, 'base64');

  const result: SlackImageSupportResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    inboundUpload: {
      filename: 'slack-image-e2e-red.png',
      sizeBytes: redPng.byteLength,
    },
    matched: {
      inboundMarker: false,
      outboundImagePosted: false,
      outboundMarker: false,
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

    const anchor = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: `SLACK_IMAGE_SUPPORT_E2E anchor runId=${runId} (no bot mention; thread setup)`,
      unfurl_links: false,
      unfurl_media: false,
    });
    result.rootMessageTs = anchor.ts;
    console.info('Posted anchor message: %s', anchor.ts);

    const uploadResult = await triggerClient.uploadFileToThread({
      alt_text: 'E2E solid red square',
      channel_id: env.SLACK_E2E_CHANNEL_ID,
      data: redPng,
      filename: 'slack-image-e2e-red.png',
      thread_ts: anchor.ts,
    });
    if (result.inboundUpload) {
      result.inboundUpload.completeResponse = uploadResult;
    }

    await delay(2_000);

    const inboundPrompt = [
      `<@${botIdentity.user_id}> SLACK_IMAGE_SUPPORT_E2E ${runId} INBOUND`,
      `There is a PNG attached in this thread (uploaded above). It is a single solid color.`,
      `What color is it? Reply with exactly one line that includes the exact text LIVE_E2E_IMAGE_OK ${runId} INBOUND and the English color name.`,
    ].join(' ');

    const inboundUserMessage = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: inboundPrompt,
      thread_ts: anchor.ts,
      unfurl_links: false,
      unfurl_media: false,
    });
    console.info('Posted inbound prompt: %s', inboundUserMessage.ts);

    const deadlineInbound = Date.now() + env.SLACK_E2E_TIMEOUT_MS;
    while (Date.now() < deadlineInbound) {
      const replies = await botClient.conversationReplies({
        channel: env.SLACK_E2E_CHANNEL_ID,
        inclusive: true,
        limit: 50,
        ts: anchor.ts,
      });

      for (const message of replies.messages ?? []) {
        if (!message.ts || !messageTsAfter(message.ts, inboundUserMessage.ts)) continue;
        if (!isAssistantMessage(message, botIdentity.user_id)) continue;
        const text = typeof message.text === 'string' ? message.text : '';
        const marker = `LIVE_E2E_IMAGE_OK ${runId}`;
        if (text.includes(marker) && text.includes('INBOUND')) {
          result.assistantInboundReplyText = text;
          result.assistantInboundReplyTs = message.ts;
          result.matched.inboundMarker = true;
          break;
        }
      }

      if (result.matched.inboundMarker) {
        break;
      }

      await delay(2_500);
    }

    if (!result.matched.inboundMarker) {
      await writeResult(result);
      throw new Error(
        `Inbound phase failed: no assistant reply containing LIVE_E2E_IMAGE_OK ${runId} INBOUND`,
      );
    }

    const outboundPrompt = [
      `<@${botIdentity.user_id}> SLACK_IMAGE_SUPPORT_E2E ${runId} OUTBOUND`,
      `Use repository ${targetRepo} for this task.`,
      `Generate a tiny solid blue square as a PNG and post it to this thread using your supported image/upload mechanism (same path you use for generated images).`,
      `Your reply must include the exact text LIVE_E2E_IMAGE_OK ${runId} OUTBOUND on one line.`,
    ].join(' ');

    const outboundUserMessage = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: outboundPrompt,
      thread_ts: anchor.ts,
      unfurl_links: false,
      unfurl_media: false,
    });
    console.info('Posted outbound prompt: %s', outboundUserMessage.ts);

    const deadlineOutbound = Date.now() + env.SLACK_E2E_TIMEOUT_MS;
    while (Date.now() < deadlineOutbound) {
      const replies = await botClient.conversationReplies({
        channel: env.SLACK_E2E_CHANNEL_ID,
        inclusive: true,
        limit: 80,
        ts: anchor.ts,
      });

      let markerText: string | undefined;
      let markerTs: string | undefined;
      let imageSample:
        | {
            blocks?: unknown;
            files?: SlackMessageFile[];
            text?: string;
            ts?: string;
          }
        | undefined;

      for (const message of replies.messages ?? []) {
        if (!message.ts) continue;
        if (!messageTsAfter(message.ts, outboundUserMessage.ts)) continue;
        if (!isAssistantMessage(message, botIdentity.user_id)) continue;

        const text = typeof message.text === 'string' ? message.text : '';
        const marker = `LIVE_E2E_IMAGE_OK ${runId}`;
        if (text.includes(marker) && text.includes('OUTBOUND')) {
          markerText = text;
          markerTs = message.ts;
        }
        if (messageHasImagePayload(message)) {
          imageSample = {
            ts: message.ts,
            ...(message.blocks !== undefined ? { blocks: message.blocks } : {}),
            ...(typeof message.text === 'string' ? { text: message.text } : {}),
            ...(message.files?.length ? { files: message.files } : {}),
          };
        }
      }

      if (markerText && markerTs) {
        result.assistantOutboundMarkerReplyText = markerText;
        result.assistantOutboundMarkerReplyTs = markerTs;
        result.matched.outboundMarker = true;
      }
      if (imageSample) {
        result.outboundImageMessageSample = imageSample;
        result.matched.outboundImagePosted = true;
      }

      if (result.matched.outboundMarker && result.matched.outboundImagePosted) {
        break;
      }

      await delay(2_500);
    }

    await writeResult(result);
    assertResult(result);
    result.passed = true;
    await writeResult(result);

    console.info('Live Slack image support E2E passed.');
    console.info('Root thread: %s', result.rootMessageTs);
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error);
    caughtError = error;
  } finally {
    await writeResult(result).catch((err) => {
      console.error('Failed to persist result:', err);
    });
    await application.stop().catch((err) => {
      console.error('Failed to stop application:', err);
    });
  }

  if (caughtError) {
    throw caughtError;
  }
}

function assertResult(result: SlackImageSupportResult): void {
  const failures: string[] = [];

  if (!result.matched.inboundMarker) {
    failures.push('inbound: assistant reply missing LIVE_E2E_IMAGE_OK … INBOUND marker');
  }
  if (!result.matched.outboundMarker) {
    failures.push('outbound: assistant reply missing LIVE_E2E_IMAGE_OK … OUTBOUND marker');
  }
  if (!result.matched.outboundImagePosted) {
    failures.push(
      'outbound: no image attachment (files with image/* or image block) from assistant after outbound prompt',
    );
  }

  if (failures.length > 0) {
    throw new Error(`Live Slack image support E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: SlackImageSupportResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'slack-image-support-result.json',
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
  id: 'slack-image-support',
  title: 'Slack image support (inbound + outbound)',
  description:
    'Upload a real PNG into a thread, verify multimodal analysis, then require a generated image posted back with deterministic markers.',
  keywords: ['image', 'multimodal', 'upload', 'vision', 'file', 'attachment'],
  run: main,
};

runDirectly(scenario);
