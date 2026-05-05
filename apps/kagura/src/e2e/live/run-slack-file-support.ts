import './load-e2e-env.js';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { env } from '~/env/server.js';
import { WorkspaceResolver } from '~/workspace/resolver.js';

import { createLiveApplication } from './live-application.js';
import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import {
  SlackApiClient,
  type SlackConversationRepliesResponse,
  type SlackMessageFile,
} from './slack-api-client.js';

interface SlackFileSupportResult {
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
    outboundFileContentVerified: boolean;
    outboundFilePosted: boolean;
    outboundMarker: boolean;
  };
  outboundFileSample?: {
    contentType?: string;
    downloadedText?: string;
    file?: SlackMessageFile;
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

function messageTsAfter(messageTs: string, afterTs: string): boolean {
  return Number(messageTs) > Number(afterTs);
}

function findMatchingFile(
  message: NonNullable<SlackConversationRepliesResponse['messages']>[number],
  expectedFileName: string,
): SlackMessageFile | undefined {
  return (message.files ?? []).find(
    (file) => file.name === expectedFileName || file.title === expectedFileName,
  );
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the Slack file support E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error(
      'Live Slack file support E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.',
    );
  }

  const runId = randomUUID();
  const targetRepo = process.env.SLACK_E2E_TARGET_REPO?.trim() || 'kagura';
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();
  const workspaceResolver = new WorkspaceResolver({
    repoRootDir: env.REPO_ROOT_DIR,
    scanDepth: env.REPO_SCAN_DEPTH,
  });
  const workspaceResolution = workspaceResolver.resolveManualInput(targetRepo, 'manual');
  const targetWorkspacePath =
    workspaceResolution.status === 'unique'
      ? workspaceResolution.workspace.workspacePath
      : undefined;

  const inboundFileName = 'slack-file-e2e-inbound.txt';
  const inboundToken = `THREAD_NOTE_${runId}`;
  const inboundText = `${inboundToken}\nSlack file inbound verification.\n`;
  const outboundFileName = `slack-file-e2e-outbound-${runId}.txt`;
  const outboundMarker = `LIVE_E2E_FILE_OK ${runId} OUTBOUND`;

  const result: SlackFileSupportResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    inboundUpload: {
      filename: inboundFileName,
      sizeBytes: Buffer.byteLength(inboundText, 'utf8'),
    },
    matched: {
      inboundMarker: false,
      outboundFileContentVerified: false,
      outboundFilePosted: false,
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
      text: `SLACK_FILE_SUPPORT_E2E anchor runId=${runId} (no bot mention; thread setup)`,
      unfurl_links: false,
      unfurl_media: false,
    });
    result.rootMessageTs = anchor.ts;

    const uploadResult = await triggerClient.uploadFileToThread({
      channel_id: env.SLACK_E2E_CHANNEL_ID,
      data: Buffer.from(inboundText, 'utf8'),
      filename: inboundFileName,
      thread_ts: anchor.ts,
      title: inboundFileName,
    });
    if (result.inboundUpload) {
      result.inboundUpload.completeResponse = uploadResult;
    }

    await delay(2_000);

    const inboundPrompt = [
      `<@${botIdentity.user_id}> SLACK_FILE_SUPPORT_E2E ${runId} INBOUND`,
      'There is a plain-text file attached in this thread.',
      `Read it and reply with exactly one line that includes the exact text LIVE_E2E_FILE_OK ${runId} INBOUND and the token ${inboundToken}.`,
    ].join(' ');

    const inboundUserMessage = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: inboundPrompt,
      thread_ts: anchor.ts,
      unfurl_links: false,
      unfurl_media: false,
    });

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
        if (text.includes(`LIVE_E2E_FILE_OK ${runId} INBOUND`) && text.includes(inboundToken)) {
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
        `Inbound phase failed: no assistant reply containing LIVE_E2E_FILE_OK ${runId} INBOUND and ${inboundToken}`,
      );
    }

    const outboundPrompt = [
      `<@${botIdentity.user_id}> SLACK_FILE_SUPPORT_E2E ${runId} OUTBOUND`,
      targetWorkspacePath
        ? `Use workspace path ${targetWorkspacePath} for this task.`
        : `Use repository ${targetRepo} for this task.`,
      `Create a plain-text file named ${outboundFileName} containing exactly "${outboundMarker}" and upload it to this thread.`,
      `You must actually save the file locally and then call upload_slack_file with that file path before finishing; a text-only reply is not sufficient.`,
      `Your reply must also include the exact text ${outboundMarker} on one line.`,
    ].join(' ');

    const outboundUserMessage = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: outboundPrompt,
      thread_ts: anchor.ts,
      unfurl_links: false,
      unfurl_media: false,
    });

    const deadlineOutbound = Date.now() + env.SLACK_E2E_TIMEOUT_MS;
    while (Date.now() < deadlineOutbound) {
      const replies = await botClient.conversationReplies({
        channel: env.SLACK_E2E_CHANNEL_ID,
        inclusive: true,
        limit: 80,
        ts: anchor.ts,
      });

      for (const message of replies.messages ?? []) {
        if (!message.ts || !messageTsAfter(message.ts, outboundUserMessage.ts)) continue;
        if (!isAssistantMessage(message, botIdentity.user_id)) continue;

        const text = typeof message.text === 'string' ? message.text : '';
        if (text.includes(outboundMarker)) {
          result.assistantOutboundMarkerReplyText = text;
          result.assistantOutboundMarkerReplyTs = message.ts;
          result.matched.outboundMarker = true;
        }

        const file = findMatchingFile(message, outboundFileName);
        if (!file) {
          continue;
        }

        result.matched.outboundFilePosted = true;
        result.outboundFileSample = {
          ...(typeof message.text === 'string' ? { text: message.text } : {}),
          ...(message.ts ? { ts: message.ts } : {}),
          file,
        };

        if (file.url_private) {
          const downloaded = await botClient.downloadPrivateTextFile(file.url_private);
          result.outboundFileSample = {
            ...result.outboundFileSample,
            contentType: downloaded.contentType,
            downloadedText: downloaded.text,
          };

          if (downloaded.text.includes(outboundMarker)) {
            result.matched.outboundFileContentVerified = true;
          }
        }
      }

      if (result.matched.outboundMarker && result.matched.outboundFileContentVerified) {
        break;
      }

      await delay(2_500);
    }

    await writeResult(result);
    assertResult(result);
    result.passed = true;
    await writeResult(result);
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

function assertResult(result: SlackFileSupportResult): void {
  const failures: string[] = [];

  if (!result.matched.inboundMarker) {
    failures.push('inbound: assistant reply missing LIVE_E2E_FILE_OK … INBOUND marker');
  }
  if (!result.matched.outboundMarker) {
    failures.push('outbound: assistant reply missing LIVE_E2E_FILE_OK … OUTBOUND marker');
  }
  if (!result.matched.outboundFilePosted) {
    failures.push('outbound: no Slack-hosted file attachment from assistant after outbound prompt');
  }
  if (!result.matched.outboundFileContentVerified) {
    failures.push('outbound: uploaded file content did not contain expected marker');
  }

  if (failures.length > 0) {
    throw new Error(`Live Slack file support E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: SlackFileSupportResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'slack-file-support-result.json',
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
  id: 'slack-file-support',
  title: 'Slack file support (inbound + outbound)',
  description:
    'Upload a real text file into a thread, verify the bot can read it, then require a generated text file uploaded back into the same thread.',
  keywords: ['file', 'attachment', 'upload', 'download', 'slack', 'thread'],
  run: main,
};

runDirectly(scenario);
