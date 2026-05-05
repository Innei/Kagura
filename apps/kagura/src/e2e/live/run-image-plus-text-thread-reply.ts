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

const RED_SQUARE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

interface ImagePlusTextThreadReplyResult {
  assistantFollowupReplyText?: string;
  assistantFollowupReplyTs?: string;
  assistantReadyReplyText?: string;
  assistantReadyReplyTs?: string;
  botUserId: string;
  channelId: string;
  failureMessage?: string;
  matched: {
    assistantFollowupReplyObserved: boolean;
    assistantReadyReplyObserved: boolean;
    followupReplyContainsMarker: boolean;
    followupReplyMentionsRed: boolean;
    uploadMessageObserved: boolean;
    uploadMessagePreservedText: boolean;
  };
  passed: boolean;
  rootMessageTs?: string;
  runId: string;
  upload?: {
    filename: string;
    sizeBytes: number;
    uploadResponse?: Record<string, unknown>;
    uploadedMessage?: {
      files?: SlackMessageFile[];
      text?: string;
      ts?: string;
      user?: string;
    };
  };
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
  return (message.files ?? []).some(
    (file) => typeof file.mimetype === 'string' && file.mimetype.startsWith('image/'),
  );
}

function messageTsAfter(messageTs: string, afterTs: string): boolean {
  return Number(messageTs) > Number(afterTs);
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error(
      'Set SLACK_E2E_ENABLED=true before running the image-plus-text-thread-reply E2E.',
    );
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error(
      'Live image-plus-text thread reply E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.',
    );
  }

  const runId = randomUUID();
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();
  const redPng = Buffer.from(RED_SQUARE_PNG_BASE64, 'base64');
  const uploadComment = `IMAGE_PLUS_TEXT payload ${runId}: please inspect the attached png and reply exactly "IMAGE_TEXT_OK ${runId} red".`;

  const result: ImagePlusTextThreadReplyResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    matched: {
      assistantFollowupReplyObserved: false,
      assistantReadyReplyObserved: false,
      followupReplyContainsMarker: false,
      followupReplyMentionsRed: false,
      uploadMessageObserved: false,
      uploadMessagePreservedText: false,
    },
    passed: false,
    runId,
    upload: {
      filename: 'image-plus-text-thread-reply-red.png',
      sizeBytes: redPng.byteLength,
    },
  };

  const application = createLiveApplication();
  let caughtError: unknown;

  try {
    await application.start();
    await delay(3_000);

    const rootPrompt = [
      `<@${botIdentity.user_id}> IMAGE_PLUS_TEXT_THREAD_REPLY_E2E ${runId}`,
      'This is a two-turn live test.',
      `For this turn only, reply with exactly "IMAGE_TEXT_READY ${runId}".`,
      'After that, wait for my next thread message.',
      'My next thread message will contain both text and a PNG image in the same Slack message.',
      `When that combined message arrives, identify the image color and reply with exactly "IMAGE_TEXT_OK ${runId} red".`,
    ].join(' ');

    const rootMessage = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: rootPrompt,
      unfurl_links: false,
      unfurl_media: false,
    });
    result.rootMessageTs = rootMessage.ts;
    console.info('Posted root message: %s', rootMessage.ts);

    const readyReply = await waitForAssistantReply({
      afterTs: rootMessage.ts,
      botClient,
      botUserId: botIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      marker: `IMAGE_TEXT_READY ${runId}`,
      rootTs: rootMessage.ts,
    });
    result.assistantReadyReplyText = readyReply.text;
    result.assistantReadyReplyTs = readyReply.ts;
    result.matched.assistantReadyReplyObserved = true;
    console.info('Observed ready reply: %s', readyReply.ts);

    const uploadResponse = await triggerClient.uploadFileToThread({
      channel_id: env.SLACK_E2E_CHANNEL_ID,
      data: redPng,
      filename: 'image-plus-text-thread-reply-red.png',
      initial_comment: uploadComment,
      thread_ts: rootMessage.ts,
      title: 'image-plus-text-thread-reply-red.png',
    });
    if (result.upload) {
      result.upload.uploadResponse = uploadResponse as Record<string, unknown>;
    }

    const uploadedMessage = await waitForUserImageUploadWithText({
      afterTs: readyReply.ts,
      botClient,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      expectedText: uploadComment,
      rootTs: rootMessage.ts,
      triggerUserTokenClient: triggerClient,
    });
    result.matched.uploadMessageObserved = true;
    result.matched.uploadMessagePreservedText =
      uploadedMessage.text?.includes(uploadComment) ?? false;
    if (result.upload) {
      result.upload.uploadedMessage = uploadedMessage;
    }
    console.info('Observed text+image upload message: %s', uploadedMessage.ts);

    const followupReply = await waitForAssistantReply({
      botClient,
      botUserId: botIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      marker: `IMAGE_TEXT_OK ${runId}`,
      rootTs: rootMessage.ts,
      ...(uploadedMessage.ts ? { afterTs: uploadedMessage.ts } : {}),
    });
    result.assistantFollowupReplyText = followupReply.text;
    result.assistantFollowupReplyTs = followupReply.ts;
    result.matched.assistantFollowupReplyObserved = true;
    result.matched.followupReplyContainsMarker = true;
    result.matched.followupReplyMentionsRed = /\bred\b/i.test(followupReply.text);
    console.info('Observed follow-up reply: %s', followupReply.ts);

    await writeResult(result);
    assertResult(result);
    result.passed = true;
    await writeResult(result);

    console.info('Live image-plus-text thread reply E2E passed.');
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

async function waitForAssistantReply(input: {
  afterTs?: string;
  botClient: SlackApiClient;
  botUserId: string;
  channelId: string;
  marker: string;
  rootTs: string;
}): Promise<{ text: string; ts: string }> {
  const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const replies = await input.botClient.conversationReplies({
      channel: input.channelId,
      inclusive: true,
      limit: 80,
      ts: input.rootTs,
    });

    for (const message of replies.messages ?? []) {
      if (!message.ts || typeof message.text !== 'string') continue;
      if (input.afterTs && !messageTsAfter(message.ts, input.afterTs)) continue;
      if (!isAssistantMessage(message, input.botUserId)) continue;
      if (!message.text.includes(input.marker)) continue;

      return { text: message.text, ts: message.ts };
    }

    await delay(2_500);
  }

  throw new Error(`Assistant reply containing "${input.marker}" was not observed in time.`);
}

async function waitForUserImageUploadWithText(input: {
  afterTs: string;
  botClient: SlackApiClient;
  channelId: string;
  expectedText: string;
  rootTs: string;
  triggerUserTokenClient: SlackApiClient;
}): Promise<{
  files?: SlackMessageFile[];
  text?: string;
  ts?: string;
  user?: string;
}> {
  const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;
  const triggerIdentity = await input.triggerUserTokenClient.authTest();

  while (Date.now() < deadline) {
    const replies = await input.botClient.conversationReplies({
      channel: input.channelId,
      inclusive: true,
      limit: 80,
      ts: input.rootTs,
    });

    for (const message of replies.messages ?? []) {
      if (!message.ts || !messageTsAfter(message.ts, input.afterTs)) continue;
      if (message.user !== triggerIdentity.user_id) continue;
      if (!messageHasImagePayload(message)) continue;
      if (typeof message.text !== 'string' || !message.text.includes(input.expectedText)) continue;

      return {
        ...(message.files?.length ? { files: message.files } : {}),
        text: message.text,
        ts: message.ts,
        ...(typeof message.user === 'string' ? { user: message.user } : {}),
      };
    }

    await delay(1_500);
  }

  throw new Error('The user text+image upload message was not observed in the thread.');
}

function assertResult(result: ImagePlusTextThreadReplyResult): void {
  const failures: string[] = [];

  if (!result.matched.assistantReadyReplyObserved) {
    failures.push('assistant did not acknowledge the setup turn with the ready marker');
  }
  if (!result.matched.uploadMessageObserved) {
    failures.push('text+image upload message was not observed after the setup turn');
  }
  if (!result.matched.uploadMessagePreservedText) {
    failures.push('text+image upload message did not preserve the expected comment text');
  }
  if (!result.matched.assistantFollowupReplyObserved) {
    failures.push('assistant did not reply after the text+image thread message');
  }
  if (!result.matched.followupReplyContainsMarker) {
    failures.push('follow-up reply missing IMAGE_TEXT_OK marker');
  }
  if (!result.matched.followupReplyMentionsRed) {
    failures.push('follow-up reply did not identify the uploaded image as red');
  }

  if (failures.length > 0) {
    throw new Error(`Live image-plus-text thread reply E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: ImagePlusTextThreadReplyResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'image-plus-text-thread-reply-result.json',
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
  id: 'image-plus-text-thread-reply',
  title: 'Image Plus Text Thread Reply',
  description:
    'Establish a thread session, then send one Slack thread message that contains both text and a PNG, and verify the bot replies from the combined input.',
  keywords: ['image', 'text', 'thread', 'reply', 'ingress', 'file', 'vision'],
  run: main,
};

runDirectly(scenario);
