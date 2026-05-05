import './load-e2e-env.js';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { createApplication } from '~/application.js';
import { env } from '~/env/server.js';
import type { SlackStatusProbeRecord } from '~/slack/render/status-probe.js';

import { applyLiveE2EDatabaseMigrations } from './db-migrations.js';
import { readSlackStatusProbeFile, resetSlackStatusProbeFile } from './file-slack-status-probe.js';
import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import { SlackApiClient } from './slack-api-client.js';

interface PiAgentProviderResult {
  assistantReplyText?: string;
  assistantReplyTs?: string;
  botUserId: string;
  channelId: string;
  failureMessage?: string;
  matched: {
    assistantReplied: boolean;
    piStatusObserved: boolean;
    progressMessagePosted: boolean;
    replyContainsMarker: boolean;
    toolProgressObserved: boolean;
    usageContextObserved: boolean;
  };
  passed: boolean;
  probePath: string;
  probeRecords: SlackStatusProbeRecord[];
  rootMessageTs?: string;
  runId: string;
  targetRepo: string;
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the pi-agent provider E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error('Live E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.');
  }

  const runId = randomUUID();
  const dbPath = e2ePath(`pi-agent-provider-${runId}.db`);
  const a2aDbPath = e2ePath(`pi-agent-provider-a2a-${runId}.db`);
  const targetRepo = process.env.SLACK_E2E_TARGET_REPO?.trim() || 'slack-cc-bot';
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();

  applyLiveE2EDatabaseMigrations(dbPath);
  await resetSlackStatusProbeFile(env.SLACK_E2E_STATUS_PROBE_PATH);

  const result: PiAgentProviderResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    matched: {
      assistantReplied: false,
      piStatusObserved: false,
      progressMessagePosted: false,
      replyContainsMarker: false,
      toolProgressObserved: false,
      usageContextObserved: false,
    },
    passed: false,
    probePath: env.SLACK_E2E_STATUS_PROBE_PATH,
    probeRecords: [],
    runId,
    targetRepo,
  };

  const application = createApplication({
    a2aCoordinatorDbPath: a2aDbPath,
    defaultProviderId: 'pi-agent',
    sessionDbPath: dbPath,
    skipManifestSync: true,
  });
  let caughtError: unknown;

  try {
    await application.start();
    await delay(3_000);

    const prompt = [
      `<@${botIdentity.user_id}> PI_AGENT_PROVIDER_E2E ${runId}`,
      `Use repository ${targetRepo} for this task.`,
      'Use the ls tool once to list the current directory.',
      'Do not edit files.',
      `Reply with exactly one line: "PI_AGENT_LIVE_OK ${runId}".`,
    ].join(' ');

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
        if (typeof message.text !== 'string') continue;

        if (message.text.includes(`PI_AGENT_LIVE_OK ${runId}`)) {
          result.assistantReplyText = message.text;
          result.assistantReplyTs = message.ts;
          result.matched.assistantReplied = true;
          result.matched.replyContainsMarker = true;
        }

        if (message.text.includes('zai/') || message.text.includes('pi-agent')) {
          result.matched.usageContextObserved = true;
        }
      }

      if (result.matched.assistantReplied && result.matched.usageContextObserved) {
        break;
      }

      await delay(2_500);
    }

    const probeRecords = await readSlackStatusProbeFile(env.SLACK_E2E_STATUS_PROBE_PATH);
    result.probeRecords = probeRecords.filter((record) => record.threadTs === rootMessage.ts);
    analyzeProbeRecords(result);

    await writeResult(result);
    assertResult(result);
    result.passed = true;
    await writeResult(result);

    console.info('Live pi-agent provider E2E passed.');
    console.info('Root thread: %s', result.rootMessageTs);
    console.info('Assistant reply: %s', result.assistantReplyTs);
    console.info('Pi status observed: %s', result.matched.piStatusObserved);
    console.info('Progress posted: %s', result.matched.progressMessagePosted);
    console.info('Usage context observed: %s', result.matched.usageContextObserved);
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

function analyzeProbeRecords(result: PiAgentProviderResult): void {
  for (const record of result.probeRecords) {
    if (
      record.kind === 'status' &&
      !record.clear &&
      (record.status.includes('Pi Agent') ||
        record.loadingMessages?.some((message) => message.includes('Pi Agent')))
    ) {
      result.matched.piStatusObserved = true;
    }

    if (record.kind === 'progress-message' && record.action === 'post') {
      result.matched.progressMessagePosted = true;
    }
    if (
      record.kind === 'progress-message' &&
      typeof record.text === 'string' &&
      record.text.includes('Pi Agent')
    ) {
      result.matched.piStatusObserved = true;
    }
    if (
      record.kind === 'progress-message' &&
      typeof record.text === 'string' &&
      record.text.includes('Listing files')
    ) {
      result.matched.toolProgressObserved = true;
    }
  }
}

function assertResult(result: PiAgentProviderResult): void {
  const failures: string[] = [];

  if (!result.matched.assistantReplied) {
    failures.push('assistant did not reply within timeout');
  }
  if (!result.matched.replyContainsMarker) {
    failures.push(`reply does not contain expected marker "PI_AGENT_LIVE_OK ${result.runId}"`);
  }
  if (!result.matched.piStatusObserved) {
    failures.push('Pi Agent status was not observed in Slack status probe');
  }
  if (!result.matched.progressMessagePosted) {
    failures.push('no progress message was posted for Pi tool activity');
  }
  if (!result.matched.toolProgressObserved) {
    failures.push('Pi ls tool progress was not observed in Slack progress probe');
  }
  if (!result.matched.usageContextObserved) {
    failures.push('usage context was not observed on the final Slack reply');
  }

  if (failures.length > 0) {
    throw new Error(`Live pi-agent provider E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: PiAgentProviderResult): Promise<void> {
  const absolutePath = e2ePath('pi-agent-provider-result.json');
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

function e2ePath(fileName: string): string {
  return path.resolve(process.cwd(), env.SLACK_E2E_RESULT_PATH.replace(/result\.json$/, fileName));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export const scenario: LiveE2EScenario = {
  id: 'pi-agent-provider',
  provider: {
    kind: 'specific',
    providerId: 'pi-agent',
    reason: 'Dedicated Pi Agent provider smoke test.',
  },
  title: 'Pi Agent Provider',
  description:
    'Verify that the pi-agent provider can answer from Slack and render Pi status, tool progress, and usage context.',
  keywords: ['pi-agent', 'provider', 'json', 'tool', 'progress', 'usage'],
  run: main,
};

runDirectly(scenario);
