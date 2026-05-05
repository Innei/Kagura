import './load-e2e-env.js';

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';

import { env } from '~/env/server.js';

import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import {
  SlackApiClient,
  type SlackConversationRepliesResponse,
  type SlackPostedMessageResponse,
} from './slack-api-client.js';

interface Pm2CodexMemoryCliResult {
  botUserId: string;
  channelId: string;
  dbPath: string;
  failureMessage?: string;
  firstReplyText?: string;
  firstReplyTs?: string;
  matched: {
    memoryPersisted: boolean;
    pm2Started: boolean;
    recallReplyObserved: boolean;
    saveReplyObserved: boolean;
  };
  passed: boolean;
  pm2Name: string;
  pm2NodeInterpreter?: string;
  recalledMemoryId?: string;
  recallReplyText?: string;
  recallReplyTs?: string;
  rootMessageTs?: string;
  runId: string;
  savedMarker: string;
  savedMemoryId?: string;
  secondRootMessageTs?: string;
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the PM2 memory CLI E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error(
      'Live PM2 memory CLI E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.',
    );
  }

  assertBuiltProductionEntrypoints();

  const runId = randomUUID();
  const secret = randomUUID();
  const savedMarker = `PM2_MEMORY_CLI_MARKER ${runId} ${secret}`;
  const pm2Name = `kagura-e2e-memory-${runId.slice(0, 8)}`;
  const dbPath = path.resolve(
    process.cwd(),
    env.SLACK_E2E_RESULT_PATH.replace(/result\.json$/, `pm2-memory-${runId}.db`),
  );
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();

  const result: Pm2CodexMemoryCliResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    dbPath,
    matched: {
      memoryPersisted: false,
      pm2Started: false,
      recallReplyObserved: false,
      saveReplyObserved: false,
    },
    passed: false,
    pm2Name,
    runId,
    savedMarker,
  };

  let caughtError: unknown;

  try {
    const pm2NodeInterpreter = resolveCompatibleNodeInterpreter();
    result.pm2NodeInterpreter = pm2NodeInterpreter;
    await startPm2App(pm2Name, dbPath, pm2NodeInterpreter);
    result.matched.pm2Started = true;
    await writeResult(result);
    await delay(5_000);

    await runSavePhase({
      botClient,
      botUserId: botIdentity.user_id,
      dbPath,
      result,
      runId,
      savedMarker,
      triggerClient,
    });
    await writeResult(result);
    assertSavePhase(result);

    await runRecallPhase({
      botClient,
      botUserId: botIdentity.user_id,
      result,
      runId,
      savedMarker,
      triggerClient,
    });
    assertRecallPhase(result);
    result.passed = true;
    await writeResult(result);

    console.info('Live PM2 Codex memory CLI E2E passed.');
    console.info('PM2 app: %s', pm2Name);
    console.info('Phase 1 thread: %s', result.rootMessageTs);
    console.info('Phase 2 thread: %s', result.secondRootMessageTs);
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error);
    caughtError = error;
  } finally {
    await writeResult(result).catch((error) => {
      console.error('Failed to persist result:', error);
    });
    stopPm2App(pm2Name);
  }

  if (caughtError) {
    throw caughtError;
  }
}

function assertBuiltProductionEntrypoints(): void {
  const missing = ['dist/index.js', 'dist/memory-cli.js'].filter(
    (entry) => !fs.existsSync(path.resolve(process.cwd(), entry)),
  );
  if (missing.length > 0) {
    throw new Error(`Build production entrypoints before this E2E: ${missing.join(', ')}`);
  }
}

async function startPm2App(
  pm2Name: string,
  dbPath: string,
  nodeInterpreter: string,
): Promise<void> {
  const resultDir = path.dirname(dbPath);
  await fsp.mkdir(resultDir, { recursive: true });

  runPm2(
    [
      'start',
      'dist/index.js',
      '--name',
      pm2Name,
      '--cwd',
      process.cwd(),
      '--interpreter',
      nodeInterpreter,
      '--update-env',
      '--time',
    ],
    {
      ...process.env,
      AGENT_DEFAULT_PROVIDER: 'codex-cli',
      KAGURA_MEMORY_RECONCILER_ENABLED: 'false',
      NODE_ENV: 'production',
      SESSION_DB_PATH: dbPath,
    },
  );
}

function resolveCompatibleNodeInterpreter(): string {
  const candidates = [
    process.env.KAGURA_E2E_PM2_NODE,
    process.execPath,
    ...candidateNodesFromPath(process.env.PATH),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const unique = [...new Set(candidates)];

  for (const candidate of unique) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    const result = spawnSync(
      candidate,
      ['-e', "const Database = require('better-sqlite3'); new Database(':memory:').close();"],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: process.env,
      },
    );
    if (result.status === 0) {
      return candidate;
    }
  }

  throw new Error(
    `No Node interpreter in PATH can load better-sqlite3. Tried: ${unique.join(', ')}`,
  );
}

function candidateNodesFromPath(searchPath: string | undefined): string[] {
  if (!searchPath) {
    return [];
  }
  return searchPath.split(path.delimiter).map((entry) => path.join(entry, 'node'));
}

function stopPm2App(pm2Name: string): void {
  const result = spawnSync('pm2', ['delete', pm2Name], {
    encoding: 'utf8',
    env: process.env,
  });
  if (result.status !== 0 && !`${result.stderr}\n${result.stdout}`.includes('not found')) {
    console.error('Failed to delete PM2 app %s: %s%s', pm2Name, result.stdout, result.stderr);
  }
}

function runPm2(args: string[], commandEnv: NodeJS.ProcessEnv): void {
  const result = spawnSync('pm2', args, {
    encoding: 'utf8',
    env: commandEnv,
  });
  if (result.status !== 0) {
    throw new Error(`pm2 ${args.join(' ')} failed: ${result.stdout}${result.stderr}`);
  }
}

async function runSavePhase(input: {
  botClient: SlackApiClient;
  botUserId: string;
  dbPath: string;
  result: Pm2CodexMemoryCliResult;
  runId: string;
  savedMarker: string;
  triggerClient: SlackApiClient;
}): Promise<void> {
  const prompt = [
    `<@${input.botUserId}> PM2_MEMORY_CLI_SAVE_E2E ${input.runId}`,
    'This is a production PM2 verification. Use the shell command path exposed by Kagura.',
    `Run kagura-memory save with category "decision", scope "global", and content exactly "${input.savedMarker}".`,
    `After saving, reply with exactly one line: "PM2_MEMORY_CLI_SAVE_OK ${input.runId}".`,
    'Do not use file-editing tools.',
  ].join(' ');

  const rootMessage = await input.triggerClient.postMessage({
    channel: env.SLACK_E2E_CHANNEL_ID!,
    text: prompt,
    unfurl_links: false,
    unfurl_media: false,
  });
  input.result.rootMessageTs = rootMessage.ts;
  console.info('Phase 1: posted root message %s', rootMessage.ts);

  const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const replies = await input.botClient.conversationReplies({
      channel: env.SLACK_E2E_CHANNEL_ID!,
      inclusive: true,
      limit: 50,
      ts: rootMessage.ts,
    });

    const reply = findReply(replies, rootMessage, `PM2_MEMORY_CLI_SAVE_OK ${input.runId}`);
    if (reply) {
      input.result.firstReplyText = reply.text;
      input.result.firstReplyTs = reply.ts;
      input.result.matched.saveReplyObserved = true;
    }

    const saved = readGlobalMemory(input.dbPath, input.savedMarker);
    if (saved) {
      input.result.savedMemoryId = saved.id;
      input.result.matched.memoryPersisted = true;
    }

    if (input.result.matched.saveReplyObserved && input.result.matched.memoryPersisted) {
      break;
    }

    await delay(2_500);
  }
}

async function runRecallPhase(input: {
  botClient: SlackApiClient;
  botUserId: string;
  result: Pm2CodexMemoryCliResult;
  runId: string;
  savedMarker: string;
  triggerClient: SlackApiClient;
}): Promise<void> {
  const prompt = [
    `<@${input.botUserId}> PM2_MEMORY_CLI_RECALL_E2E ${input.runId}`,
    'Use shell to run kagura-memory recall with category "decision", scope "global",',
    `query "${input.runId}", and limit 5.`,
    'Return the recalled memory content exactly.',
    `Reply with exactly one line: "PM2_MEMORY_CLI_RECALL_OK ${input.runId}" followed by the recalled content.`,
    'The secret suffix was not provided in this phase; obtain it from kagura-memory recall output.',
    'Do not use file-editing tools.',
  ].join(' ');

  const rootMessage = await input.triggerClient.postMessage({
    channel: env.SLACK_E2E_CHANNEL_ID!,
    text: prompt,
    unfurl_links: false,
    unfurl_media: false,
  });
  input.result.secondRootMessageTs = rootMessage.ts;
  console.info('Phase 2: posted root message %s', rootMessage.ts);

  const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const replies = await input.botClient.conversationReplies({
      channel: env.SLACK_E2E_CHANNEL_ID!,
      inclusive: true,
      limit: 50,
      ts: rootMessage.ts,
    });

    const reply = findRecallReply(replies, rootMessage, input.runId, input.savedMarker);
    if (reply) {
      input.result.recallReplyText = reply.text;
      input.result.recallReplyTs = reply.ts;
      if (input.result.savedMemoryId) {
        input.result.recalledMemoryId = input.result.savedMemoryId;
      }
      input.result.matched.recallReplyObserved = true;
      break;
    }

    await delay(2_500);
  }
}

function findReply(
  replies: SlackConversationRepliesResponse,
  rootMessage: SlackPostedMessageResponse,
  marker: string,
): { text: string; ts: string } | undefined {
  return replies.messages?.find((message) => {
    if (!message.ts || message.ts === rootMessage.ts) return false;
    return typeof message.text === 'string' && message.text.includes(marker);
  }) as { text: string; ts: string } | undefined;
}

function findRecallReply(
  replies: SlackConversationRepliesResponse,
  rootMessage: SlackPostedMessageResponse,
  runId: string,
  savedMarker: string,
): { text: string; ts: string } | undefined {
  return replies.messages?.find((message) => {
    if (!message.ts || message.ts === rootMessage.ts || typeof message.text !== 'string') {
      return false;
    }
    return (
      message.text.includes(`PM2_MEMORY_CLI_RECALL_OK ${runId}`) &&
      message.text.includes(savedMarker)
    );
  }) as { text: string; ts: string } | undefined;
}

function readGlobalMemory(dbPath: string, marker: string): { id: string } | undefined {
  if (!fs.existsSync(dbPath)) {
    return undefined;
  }

  const sqlite = new Database(dbPath, { readonly: true });
  try {
    const row = sqlite
      .prepare(
        `
          SELECT id
          FROM memories
          WHERE repo_id IS NULL
            AND category = 'decision'
            AND content = @marker
          ORDER BY created_at DESC
          LIMIT 1
        `,
      )
      .get({ marker }) as { id: string } | undefined;
    return row;
  } catch {
    return undefined;
  } finally {
    sqlite.close();
  }
}

function assertSavePhase(result: Pm2CodexMemoryCliResult): void {
  const failures: string[] = [];
  if (!result.matched.pm2Started) {
    failures.push('PM2 production process did not start');
  }
  if (!result.matched.saveReplyObserved) {
    failures.push('PM2 Codex run did not reply with save confirmation');
  }
  if (!result.matched.memoryPersisted) {
    failures.push('kagura-memory save did not persist a global decision memory');
  }
  if (failures.length > 0) {
    throw new Error(`PM2 Codex memory CLI save phase failed: ${failures.join('; ')}`);
  }
}

function assertRecallPhase(result: Pm2CodexMemoryCliResult): void {
  if (!result.matched.recallReplyObserved) {
    throw new Error(
      'PM2 Codex memory CLI recall phase failed: recalled secret marker was not observed',
    );
  }
}

async function writeResult(result: Pm2CodexMemoryCliResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'pm2-codex-memory-cli-result.json',
  );
  const absolutePath = path.resolve(process.cwd(), resultPath);
  await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
  await fsp.writeFile(absolutePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export const scenario: LiveE2EScenario = {
  id: 'pm2-codex-memory-cli',
  provider: {
    kind: 'specific',
    providerId: 'codex-cli',
    reason: 'Starts a PM2 Codex production app.',
  },
  title: 'PM2 Codex Memory CLI',
  description:
    'Starts the compiled production app under PM2 and verifies Codex can save and recall memory through kagura-memory.',
  keywords: ['pm2', 'production', 'codex', 'memory', 'kagura-memory', 'recall', 'save'],
  run: main,
};

runDirectly(scenario);
