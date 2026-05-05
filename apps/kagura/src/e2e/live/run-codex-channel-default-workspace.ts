import './load-e2e-env.js';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';

import { createApplication } from '~/application.js';
import { env } from '~/env/server.js';
import { WorkspaceResolver } from '~/workspace/resolver.js';

import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import {
  SlackApiClient,
  type SlackConversationRepliesResponse,
  type SlackPostedMessageResponse,
} from './slack-api-client.js';

interface CodexChannelDefaultWorkspaceResult {
  botUserId: string;
  channelId: string;
  failureMessage?: string;
  matched: {
    defaultWorkspacePersisted: boolean;
    fallbackAssistantReplied: boolean;
    fallbackReplyContainsMarker: boolean;
    setAssistantReplied: boolean;
    setReplyContainsMarker: boolean;
    workspaceLabelPresent: boolean;
  };
  passed: boolean;
  restoredWorkspaceInput?: string;
  runId: string;
  setReplyText?: string;
  setReplyTs?: string;
  setThreadTs?: string;
  targetRepo: string;
  workspaceReplyBlocks?: unknown[];
  workspaceReplyText?: string;
  workspaceReplyTs?: string;
  workspaceThreadTs?: string;
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error(
      'Set SLACK_E2E_ENABLED=true before running the Codex channel default workspace E2E.',
    );
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error(
      'Live Codex channel default workspace E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.',
    );
  }

  const channelId = env.SLACK_E2E_CHANNEL_ID;
  const targetRepo = process.env.SLACK_E2E_TARGET_REPO?.trim() || 'work/lobe-chat';
  assertWorkspaceResolvable(targetRepo);

  const runId = randomUUID();
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();
  const originalPreference = readChannelPreference(channelId);

  const result: CodexChannelDefaultWorkspaceResult = {
    botUserId: botIdentity.user_id,
    channelId,
    matched: {
      defaultWorkspacePersisted: false,
      fallbackAssistantReplied: false,
      fallbackReplyContainsMarker: false,
      setAssistantReplied: false,
      setReplyContainsMarker: false,
      workspaceLabelPresent: false,
    },
    passed: false,
    runId,
    targetRepo,
    ...(originalPreference ? { restoredWorkspaceInput: originalPreference } : {}),
  };

  const application = createApplication({ defaultProviderId: 'codex-cli' });
  let caughtError: unknown;

  try {
    await application.start();
    await delay(3_000);

    await runSetDefaultWorkspacePhase({
      botIdentityUserId: botIdentity.user_id,
      botClient,
      channelId,
      result,
      targetRepo,
      triggerClient,
    });

    result.matched.defaultWorkspacePersisted = await waitForChannelPreference(
      channelId,
      targetRepo,
    );

    await runFallbackWorkspacePhase({
      botIdentityUserId: botIdentity.user_id,
      botClient,
      channelId,
      result,
      triggerClient,
    });

    await writeResult(result);
    assertResult(result);
    result.passed = true;
    await writeResult(result);

    console.info('Live Codex channel default workspace E2E passed.');
    console.info('Set thread: %s', result.setThreadTs);
    console.info('Fallback thread: %s', result.workspaceThreadTs);
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error);
    caughtError = error;
  } finally {
    restoreChannelPreference(channelId, originalPreference);
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

async function runSetDefaultWorkspacePhase(input: {
  botClient: SlackApiClient;
  botIdentityUserId: string;
  channelId: string;
  result: CodexChannelDefaultWorkspaceResult;
  targetRepo: string;
  triggerClient: SlackApiClient;
}): Promise<void> {
  const prompt = [
    `<@${input.botIdentityUserId}> CODEX_CHANNEL_DEFAULT_WORKSPACE_SET_E2E ${input.result.runId}`,
    `For this Slack channel, set the default workspace to exactly "${input.targetRepo}" for future conversations.`,
    `Before replying, call set_channel_default_workspace with workspaceInput exactly "${input.targetRepo}".`,
    `Reply with exactly one line: "CODEX_CHANNEL_DEFAULT_WORKSPACE_SET_OK ${input.result.runId}".`,
    'Do not modify repository files.',
  ].join(' ');

  const rootMessage = await input.triggerClient.postMessage({
    channel: input.channelId,
    text: prompt,
    unfurl_links: false,
    unfurl_media: false,
  });
  input.result.setThreadTs = rootMessage.ts;
  console.info('Posted set-default root message: %s', rootMessage.ts);

  const marker = `CODEX_CHANNEL_DEFAULT_WORKSPACE_SET_OK ${input.result.runId}`;
  const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const replies = await input.botClient.conversationReplies({
      channel: input.channelId,
      inclusive: true,
      limit: 50,
      ts: rootMessage.ts,
    });

    const reply = findReplyWithMarker(replies, rootMessage, marker);
    if (reply) {
      input.result.setReplyText = reply.text;
      input.result.setReplyTs = reply.ts;
      input.result.matched.setAssistantReplied = true;
      input.result.matched.setReplyContainsMarker = true;
      return;
    }

    await delay(2_500);
  }
}

async function runFallbackWorkspacePhase(input: {
  botClient: SlackApiClient;
  botIdentityUserId: string;
  channelId: string;
  result: CodexChannelDefaultWorkspaceResult;
  triggerClient: SlackApiClient;
}): Promise<void> {
  const prompt = [
    `<@${input.botIdentityUserId}> CODEX_CHANNEL_DEFAULT_WORKSPACE_FALLBACK_E2E ${input.result.runId}`,
    'This new thread intentionally does not mention any repository or path.',
    `Reply with exactly one line: "CODEX_CHANNEL_DEFAULT_WORKSPACE_FALLBACK_OK ${input.result.runId}".`,
    'Do not use file or code tools.',
  ].join(' ');

  const rootMessage = await input.triggerClient.postMessage({
    channel: input.channelId,
    text: prompt,
    unfurl_links: false,
    unfurl_media: false,
  });
  input.result.workspaceThreadTs = rootMessage.ts;
  console.info('Posted fallback root message: %s', rootMessage.ts);

  const marker = `CODEX_CHANNEL_DEFAULT_WORKSPACE_FALLBACK_OK ${input.result.runId}`;
  const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const replies = await input.botClient.conversationReplies({
      channel: input.channelId,
      inclusive: true,
      limit: 50,
      ts: rootMessage.ts,
    });

    const reply = findReplyWithMarker(replies, rootMessage, marker);
    if (reply) {
      input.result.workspaceReplyText = reply.text;
      input.result.workspaceReplyTs = reply.ts;
      input.result.workspaceReplyBlocks = reply.blocks ?? [];
      input.result.matched.fallbackAssistantReplied = true;
      input.result.matched.fallbackReplyContainsMarker = true;
      input.result.matched.workspaceLabelPresent = hasWorkingInContextBlock(reply.blocks);
      return;
    }

    await delay(2_500);
  }
}

function assertWorkspaceResolvable(targetRepo: string): void {
  const resolver = new WorkspaceResolver({
    repoRootDir: env.REPO_ROOT_DIR,
    scanDepth: env.REPO_SCAN_DEPTH,
  });
  const resolution = resolver.resolveManualInput(targetRepo, 'manual');
  if (resolution.status !== 'unique') {
    throw new Error(
      `Target workspace ${targetRepo} did not resolve uniquely; set SLACK_E2E_TARGET_REPO to a resolvable repo id or path.`,
    );
  }
}

function findReplyWithMarker(
  replies: SlackConversationRepliesResponse,
  rootMessage: SlackPostedMessageResponse,
  marker: string,
):
  | {
      blocks?: Array<{ elements?: Array<Record<string, unknown>>; type?: string }>;
      text: string;
      ts: string;
    }
  | undefined {
  return replies.messages?.find((message) => {
    if (!message.ts || message.ts === rootMessage.ts) return false;
    return typeof message.text === 'string' && message.text.includes(marker);
  }) as
    | {
        blocks?: Array<{ elements?: Array<Record<string, unknown>>; type?: string }>;
        text: string;
        ts: string;
      }
    | undefined;
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

function readChannelPreference(channelId: string): string | undefined {
  const dbPath = path.resolve(process.cwd(), env.SESSION_DB_PATH);
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    const row = sqlite
      .prepare('SELECT default_workspace_input FROM channel_preferences WHERE channel_id = ?')
      .get(channelId) as { default_workspace_input?: string | null } | undefined;
    return row?.default_workspace_input ?? undefined;
  } finally {
    sqlite.close();
  }
}

async function waitForChannelPreference(channelId: string, expected: string): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (readChannelPreference(channelId) === expected) {
      return true;
    }
    await delay(1_000);
  }
  return false;
}

function restoreChannelPreference(channelId: string, workspaceInput: string | undefined): void {
  const dbPath = path.resolve(process.cwd(), env.SESSION_DB_PATH);
  const sqlite = new Database(dbPath);
  try {
    if (workspaceInput === undefined) {
      sqlite.prepare('DELETE FROM channel_preferences WHERE channel_id = ?').run(channelId);
      return;
    }

    const now = new Date().toISOString();
    sqlite
      .prepare(
        `
        INSERT INTO channel_preferences (channel_id, default_workspace_input, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(channel_id) DO UPDATE SET
          default_workspace_input = excluded.default_workspace_input,
          updated_at = excluded.updated_at
      `,
      )
      .run(channelId, workspaceInput, now, now);
  } finally {
    sqlite.close();
  }
}

function assertResult(result: CodexChannelDefaultWorkspaceResult): void {
  const failures: string[] = [];

  if (!result.matched.setAssistantReplied) {
    failures.push('Codex did not reply to the set-default prompt within timeout');
  }
  if (!result.matched.setReplyContainsMarker) {
    failures.push(
      `set-default reply does not contain expected marker "CODEX_CHANNEL_DEFAULT_WORKSPACE_SET_OK ${result.runId}"`,
    );
  }
  if (!result.matched.defaultWorkspacePersisted) {
    failures.push(`channel default workspace was not persisted as "${result.targetRepo}"`);
  }
  if (!result.matched.fallbackAssistantReplied) {
    failures.push('Codex did not reply to the fallback prompt within timeout');
  }
  if (!result.matched.fallbackReplyContainsMarker) {
    failures.push(
      `fallback reply does not contain expected marker "CODEX_CHANNEL_DEFAULT_WORKSPACE_FALLBACK_OK ${result.runId}"`,
    );
  }
  if (!result.matched.workspaceLabelPresent) {
    failures.push('fallback reply does not contain a "Working in" context block');
  }

  if (failures.length > 0) {
    throw new Error(`Live Codex channel default workspace E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: CodexChannelDefaultWorkspaceResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'codex-channel-default-workspace-result.json',
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
  id: 'codex-channel-default-workspace',
  provider: {
    kind: 'specific',
    providerId: 'codex-cli',
    reason: 'Exercises Codex channel preference persistence through Codex tools.',
  },
  title: 'Codex Channel Default Workspace',
  description:
    'Verify Codex can persist a channel default workspace and a later new thread without an explicit repo uses that workspace.',
  keywords: ['codex', 'channel', 'default', 'workspace', 'fallback', 'preference'],
  run: main,
};

runDirectly(scenario);
