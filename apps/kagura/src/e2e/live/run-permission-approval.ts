import './load-e2e-env.js';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import { SlackApiClient } from './slack-api-client.js';

const { createApplication } = await import('~/application.js');
const { env } = await import('~/env/server.js');
const { PERMISSION_APPROVE_ACTION_ID, PERMISSION_DENY_ACTION_ID } =
  await import('~/slack/interaction/permission-bridge.js');

interface PermissionApprovalResult {
  botUserId: string;
  channelId: string;
  failureMessage?: string;
  matched: {
    permissionMessageHasApproveButton: boolean;
    permissionMessageHasDenyButton: boolean;
    permissionMessageHasCorrectFormat: boolean;
    permissionMessageContainsToolName: boolean;
    permissionMessagePosted: boolean;
  };
  observedToolName?: string;
  passed: boolean;
  permissionMessageBlocks?: unknown[] | undefined;
  permissionMessageTs?: string;
  permissionMode: string;
  rootMessageTs?: string;
  runId: string;
  targetToolName: string;
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the permission-approval E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error('Live E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.');
  }

  const runId = randomUUID();
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();

  const result: PermissionApprovalResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    matched: {
      permissionMessageHasApproveButton: false,
      permissionMessageHasDenyButton: false,
      permissionMessageHasCorrectFormat: false,
      permissionMessageContainsToolName: false,
      permissionMessagePosted: false,
    },
    passed: false,
    permissionMode: 'default',
    runId,
    targetToolName: 'Bash',
  };

  const application = createApplication({ claudePermissionMode: 'default' });
  let caughtError: unknown;

  try {
    await application.start();
    await delay(3_000);

    const prompt = [
      `<@${botIdentity.user_id}> PERMISSION_APPROVAL_E2E ${runId}.`,
      `Run this exact bash command: mkdir -p /tmp/kagura-permission-e2e && touch /tmp/kagura-permission-e2e/${runId}`,
      'Reply with the output of the command prefixed with "PERMISSION_E2E_RESULT".',
    ].join(' ');

    const rootMessage = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: prompt,
      unfurl_links: false,
      unfurl_media: false,
    });
    result.rootMessageTs = rootMessage.ts;
    console.info('Posted permission-approval root message: %s', rootMessage.ts);

    // Poll for the permission request message (not the final reply).
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
        if (message.user !== botIdentity.user_id) continue;

        if (isPermissionRequestMessage(message)) {
          result.permissionMessageTs = message.ts;
          result.matched.permissionMessagePosted = true;
          result.permissionMessageBlocks = message.blocks ?? undefined;
          analyzePermissionMessage(message, result);
          break;
        }
      }

      if (result.matched.permissionMessagePosted) {
        break;
      }

      await delay(2_500);
    }

    assertResult(result);
    if (result.rootMessageTs) {
      await application.threadExecutionRegistry.stopAll(result.rootMessageTs, 'user_stop');
    }
    result.passed = true;
    await writeResult(result);

    console.info('Permission approval E2E passed.');
    console.info('Permission message ts: %s', result.permissionMessageTs);
    console.info('Approve button: %s', result.matched.permissionMessageHasApproveButton);
    console.info('Deny button: %s', result.matched.permissionMessageHasDenyButton);
    console.info('Tool name shown: %s', result.matched.permissionMessageContainsToolName);
    console.info('Block format correct: %s', result.matched.permissionMessageHasCorrectFormat);
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

function isPermissionRequestMessage(message: {
  blocks?: Array<Record<string, unknown>>;
  text?: string;
}): boolean {
  const text = typeof message.text === 'string' ? message.text : '';
  return text.includes('需要你的授权');
}

function analyzePermissionMessage(
  message: { blocks?: Array<Record<string, unknown>>; text?: string },
  result: PermissionApprovalResult,
): void {
  const blocks = message.blocks ?? [];
  const text = typeof message.text === 'string' ? message.text : '';

  const toolName = extractToolName(text);
  if (toolName) {
    result.observedToolName = toolName;
    result.matched.permissionMessageContainsToolName = true;
  }

  for (const block of blocks) {
    if (block.type !== 'actions') continue;
    const elements = (block.elements as Array<Record<string, unknown>>) ?? [];

    for (const element of elements) {
      if (element.type !== 'button') continue;
      const actionId = element.action_id as string;

      if (actionId === PERMISSION_APPROVE_ACTION_ID) {
        result.matched.permissionMessageHasApproveButton = true;
      }
      if (actionId === PERMISSION_DENY_ACTION_ID) {
        result.matched.permissionMessageHasDenyButton = true;
      }
    }
  }

  const hasSection = blocks.some((b) => b.type === 'section');
  const hasActions = blocks.some((b) => b.type === 'actions');
  result.matched.permissionMessageHasCorrectFormat = hasSection && hasActions;
}

function extractToolName(text: string): string | undefined {
  const markdownMatch = text.match(/Claude 想要使用\s+\*([^*\n]+)\*\s+工具/u);
  if (markdownMatch?.[1]?.trim()) {
    return markdownMatch[1].trim();
  }

  const plainTextMatch = text.match(/Claude 想要使用\s+(\S(?:[^\n]*\S)?)\s+工具/u);
  if (plainTextMatch?.[1]?.trim()) {
    return plainTextMatch[1].trim();
  }

  return undefined;
}

function assertResult(result: PermissionApprovalResult): void {
  const failures: string[] = [];

  if (!result.matched.permissionMessagePosted) {
    failures.push('permission request message was not posted within timeout');
  }
  if (!result.matched.permissionMessageHasApproveButton) {
    failures.push('permission message missing Approve button');
  }
  if (!result.matched.permissionMessageHasDenyButton) {
    failures.push('permission message missing Deny button');
  }
  if (!result.matched.permissionMessageContainsToolName) {
    failures.push('permission message does not mention any tool name');
  }
  if (!result.matched.permissionMessageHasCorrectFormat) {
    failures.push('permission message does not have expected block format (section + actions)');
  }

  if (failures.length > 0) {
    throw new Error(`Permission approval E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: PermissionApprovalResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'permission-approval-result.json',
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
  id: 'permission-approval',
  provider: {
    kind: 'specific',
    providerId: 'claude-code',
    reason: 'Asserts Claude permission bridge UI.',
  },
  title: 'Permission Approval System',
  description:
    'Verify that when CLAUDE_PERMISSION_MODE is not bypassPermissions, tool usage triggers ' +
    'a permission request message in the Slack thread with Approve/Deny buttons containing ' +
    'correct action_ids.',
  keywords: ['permission', 'approval', 'deny', 'tool', 'bash', 'interactive', 'buttons'],
  run: main,
};

runDirectly(scenario);
