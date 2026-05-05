import './load-e2e-env.js';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { env } from '~/env/server.js';

import { createLiveApplication } from './live-application.js';
import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import { SlackApiClient } from './slack-api-client.js';

interface ReactionLifecycleResult {
  botUserId: string;
  channelId: string;
  failureMessage?: string;
  matched: {
    ackReactionAdded: boolean;
    ackReactionRemoved: boolean;
    doneReactionAdded: boolean;
  };
  passed: boolean;
  rootMessageTs?: string;
  runId: string;
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the reaction-lifecycle E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error('Live E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.');
  }

  const runId = randomUUID();
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();

  const result: ReactionLifecycleResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    matched: {
      ackReactionAdded: false,
      ackReactionRemoved: false,
      doneReactionAdded: false,
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
      `<@${botIdentity.user_id}> [e2e:${runId}]`,
      `Reply with exactly: "REACTION_OK ${runId}"`,
    ].join(' ');

    const posted = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: prompt,
    });
    result.rootMessageTs = posted.ts;
    console.info('[e2e] Posted trigger message: %s', posted.ts);

    const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;

    // Phase 1: wait for the acknowledgement (👀) reaction to appear
    console.info('[e2e] Waiting for acknowledgement reaction (%s)...', env.SLACK_REACTION_NAME);
    while (Date.now() < deadline) {
      await delay(1_000);
      const reactions = await getMessageReactions(
        triggerClient,
        env.SLACK_E2E_CHANNEL_ID,
        posted.ts,
      );
      if (reactions.includes(env.SLACK_REACTION_NAME)) {
        result.matched.ackReactionAdded = true;
        console.info('[e2e] Acknowledgement reaction appeared.');
        break;
      }
    }

    if (!result.matched.ackReactionAdded) {
      result.failureMessage = `Acknowledgement reaction (${env.SLACK_REACTION_NAME}) never appeared`;
      return;
    }

    // Phase 2: wait for the acknowledgement reaction to be removed (execution started)
    console.info('[e2e] Waiting for acknowledgement reaction to be removed...');
    while (Date.now() < deadline) {
      await delay(1_000);
      const reactions = await getMessageReactions(
        triggerClient,
        env.SLACK_E2E_CHANNEL_ID,
        posted.ts,
      );
      if (!reactions.includes(env.SLACK_REACTION_NAME)) {
        result.matched.ackReactionRemoved = true;
        console.info('[e2e] Acknowledgement reaction removed — execution started.');
        break;
      }
    }

    if (!result.matched.ackReactionRemoved) {
      result.failureMessage = `Acknowledgement reaction (${env.SLACK_REACTION_NAME}) was never removed`;
      return;
    }

    // Phase 3: wait for the done (✅) reaction to appear
    console.info('[e2e] Waiting for completion reaction (%s)...', env.SLACK_REACTION_DONE_NAME);
    while (Date.now() < deadline) {
      await delay(1_500);
      const reactions = await getMessageReactions(
        triggerClient,
        env.SLACK_E2E_CHANNEL_ID,
        posted.ts,
      );
      if (reactions.includes(env.SLACK_REACTION_DONE_NAME)) {
        result.matched.doneReactionAdded = true;
        console.info('[e2e] Completion reaction appeared.');
        break;
      }
    }

    result.passed =
      result.matched.ackReactionAdded &&
      result.matched.ackReactionRemoved &&
      result.matched.doneReactionAdded;

    if (!result.passed && !result.failureMessage) {
      result.failureMessage = `Completion reaction (${env.SLACK_REACTION_DONE_NAME}) never appeared`;
    }

    console.info('[e2e] Passed: %s', result.passed);
    console.info('[e2e] ack added: %s', result.matched.ackReactionAdded);
    console.info('[e2e] ack removed: %s', result.matched.ackReactionRemoved);
    console.info('[e2e] done added: %s', result.matched.doneReactionAdded);
  } catch (error) {
    caughtError = error;
    result.failureMessage = error instanceof Error ? error.message : String(error);
  } finally {
    await application.stop().catch(() => {});
  }

  const outputPath = path.resolve('data', 'reaction-lifecycle-result.json');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.info('[e2e] Result written to %s', outputPath);

  if (caughtError) {
    throw caughtError;
  }

  if (!result.passed) {
    throw new Error(`E2E failed: ${result.failureMessage ?? 'unknown reason'}`);
  }
}

async function getMessageReactions(
  client: SlackApiClient,
  channel: string,
  ts: string,
): Promise<string[]> {
  try {
    const resp = await client.getReactions({ channel, timestamp: ts });
    return (resp.message?.reactions ?? []).map((r) => r.name);
  } catch {
    return [];
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export const scenario: LiveE2EScenario = {
  id: 'reaction-lifecycle',
  title: 'Reaction Lifecycle',
  description:
    'Verifies that the bot adds a 👀 acknowledgement reaction when it receives a mention, ' +
    'removes it when execution starts, and adds a ✅ completion reaction when done.',
  keywords: ['reaction', 'ack', 'done', 'lifecycle', 'eyes', 'checkmark'],
  run: main,
};

runDirectly(scenario);
