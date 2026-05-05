import './load-e2e-env.js';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';

import { env } from '~/env/server.js';

import { createLiveApplication } from './live-application.js';
import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import { SlackApiClient } from './slack-api-client.js';

interface ChannelDefaultWorkspaceResult {
  assistantReplyText?: string;
  assistantReplyTs?: string;
  botUserId: string;
  channelId: string;
  failureMessage?: string;
  matched: {
    assistantReplied: boolean;
    replyContainsMarker: boolean;
    workspaceLabelPresent: boolean;
  };
  passed: boolean;
  rootMessageTs?: string;
  runId: string;
  targetRepo: string;
  workspaceReplyBlocks?: unknown[];
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the channel-default-workspace E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error('Live E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.');
  }

  const runId = randomUUID();
  const targetRepo = process.env.SLACK_E2E_TARGET_REPO?.trim() || 'slack-cc-bot';
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();
  const channelId = env.SLACK_E2E_CHANNEL_ID;

  const result: ChannelDefaultWorkspaceResult = {
    botUserId: botIdentity.user_id,
    channelId,
    matched: {
      assistantReplied: false,
      replyContainsMarker: false,
      workspaceLabelPresent: false,
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

    // Seed the channel preference directly in SQLite so the fallback path is tested
    seedChannelPreference(channelId, targetRepo);

    const prompt = [
      `<@${botIdentity.user_id}> CHANNEL_DEFAULT_WORKSPACE_E2E ${runId}`,
      `This message does not mention any repository.`,
      `What is 3 + 5? Reply with exactly one line: "DEFAULT_WS_OK ${runId} <answer>".`,
      `Do not use any file or code tools. Just reply directly.`,
    ].join(' ');

    const rootMessage = await triggerClient.postMessage({
      channel: channelId,
      text: prompt,
      unfurl_links: false,
      unfurl_media: false,
    });
    result.rootMessageTs = rootMessage.ts;
    console.info('Posted root message: %s', rootMessage.ts);

    const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const replies = await botClient.conversationReplies({
        channel: channelId,
        inclusive: true,
        limit: 50,
        ts: rootMessage.ts,
      });

      for (const message of replies.messages ?? []) {
        if (!message.ts || message.ts === rootMessage.ts) continue;
        if (typeof message.text !== 'string') continue;

        if (message.text.includes(`DEFAULT_WS_OK ${runId}`)) {
          result.assistantReplyText = message.text;
          result.assistantReplyTs = message.ts;
          result.matched.assistantReplied = true;
          result.matched.replyContainsMarker = true;
          result.workspaceReplyBlocks = message.blocks ?? [];

          if (hasWorkingInContextBlock(message.blocks)) {
            result.matched.workspaceLabelPresent = true;
          }
        }
      }

      if (result.matched.assistantReplied) break;
      await delay(2_500);
    }

    await writeResult(result);
    assertResult(result);
    result.passed = true;
    await writeResult(result);

    console.info('Live channel-default-workspace E2E passed.');
    console.info('Root thread: %s', result.rootMessageTs);
    console.info('Assistant reply: %s', result.assistantReplyTs);
    console.info('Workspace label present: %s', result.matched.workspaceLabelPresent);
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error);
    caughtError = error;
  } finally {
    await cleanupChannelPreference(channelId);
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

function seedChannelPreference(channelId: string, workspaceInput: string): void {
  const dbPath = path.resolve(process.cwd(), env.SESSION_DB_PATH);
  const sqlite = new Database(dbPath);
  try {
    const now = new Date().toISOString();
    sqlite.exec(`
      INSERT INTO channel_preferences (channel_id, default_workspace_input, created_at, updated_at)
      VALUES ('${channelId}', '${workspaceInput}', '${now}', '${now}')
      ON CONFLICT(channel_id) DO UPDATE SET
        default_workspace_input = '${workspaceInput}',
        updated_at = '${now}'
    `);
    console.info('Seeded channel preference for %s -> %s', channelId, workspaceInput);
  } finally {
    sqlite.close();
  }
}

function cleanupChannelPreference(channelId: string): void {
  const dbPath = path.resolve(process.cwd(), env.SESSION_DB_PATH);
  const sqlite = new Database(dbPath);
  try {
    sqlite.prepare('DELETE FROM channel_preferences WHERE channel_id = ?').run(channelId);
    console.info('Cleaned up channel preference for %s', channelId);
  } finally {
    sqlite.close();
  }
}

function hasWorkingInContextBlock(
  blocks?: Array<{ elements?: Array<Record<string, unknown>>; type?: string }>,
): boolean {
  if (!blocks) return false;
  return blocks.some(
    (block) =>
      block.type === 'context' &&
      block.elements?.some((el) => {
        const text = typeof el.text === 'string' ? el.text : '';
        return text.includes('Working in');
      }),
  );
}

function assertResult(result: ChannelDefaultWorkspaceResult): void {
  const failures: string[] = [];

  if (!result.matched.assistantReplied) {
    failures.push('assistant did not reply within timeout');
  }
  if (!result.matched.replyContainsMarker) {
    failures.push(`reply does not contain expected marker "DEFAULT_WS_OK ${result.runId}"`);
  }
  if (!result.matched.workspaceLabelPresent) {
    failures.push('reply does not contain a "Working in" context block from channel fallback');
  }

  if (failures.length > 0) {
    throw new Error(`Live channel-default-workspace E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: ChannelDefaultWorkspaceResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'channel-default-workspace-result.json',
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
  id: 'channel-default-workspace',
  title: 'Channel Default Workspace Fallback',
  description:
    'Verify that when a channel has a saved default workspace, new threads without an explicit repo mention still get the "Working in" context block.',
  keywords: ['channel', 'default', 'workspace', 'fallback', 'preference'],
  run: main,
};

runDirectly(scenario);
