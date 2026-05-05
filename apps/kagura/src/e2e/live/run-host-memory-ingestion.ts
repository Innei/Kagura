import './load-e2e-env.js';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';
import { config } from 'dotenv';

import { applyLiveE2EDatabaseMigrations } from './db-migrations.js';
import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import { SlackApiClient, type SlackConversationRepliesResponse } from './slack-api-client.js';

interface HostMemoryIngestionResult {
  assistantReplyText?: string;
  assistantReplyTs?: string;
  botUserId: string;
  candidateCount: number;
  channelId: string;
  failureMessage?: string;
  ingestionRunStatus?: string;
  matched: {
    appliedCandidate: boolean;
    assistantReplied: boolean;
    auditCandidateRecorded: boolean;
    auditRunCompleted: boolean;
    memoryPersisted: boolean;
  };
  memoryCount: number;
  passed: boolean;
  rootMessageTs?: string;
  runId: string;
}

async function main(): Promise<void> {
  config({ path: '.env', override: false });
  config({ path: '../../.env', override: false });
  process.env.KAGURA_MEMORY_RECONCILER_ENABLED = 'true';
  process.env.KAGURA_MEMORY_RECONCILER_BASE_URL ||= 'https://api.deepseek.com';
  process.env.KAGURA_MEMORY_RECONCILER_MODEL ||= 'deepseek-v4-flash';
  process.env.KAGURA_MEMORY_RECONCILER_MAX_TOKENS ||= '1024';
  process.env.KAGURA_MEMORY_RECONCILER_TIMEOUT_MS ||= '30000';

  const { createApplication } = await import('~/application.js');
  const { env } = await import('~/env/server.js');
  const { OpenAICompatibleClient } = await import('~/memory/reconciler/llm-client.js');

  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the host memory ingestion E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error(
      'Live host memory ingestion E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.',
    );
  }

  if (!env.KAGURA_MEMORY_RECONCILER_API_KEY) {
    throw new Error(
      'Live host memory ingestion E2E requires KAGURA_MEMORY_RECONCILER_API_KEY for the extraction model.',
    );
  }

  const runId = randomUUID();
  const dbPath = e2ePath(env.SLACK_E2E_RESULT_PATH, `host-memory-ingestion-${runId}.db`);
  const a2aDbPath = e2ePath(env.SLACK_E2E_RESULT_PATH, `host-memory-ingestion-a2a-${runId}.db`);
  applyLiveE2EDatabaseMigrations(dbPath);

  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();

  const result: HostMemoryIngestionResult = {
    botUserId: botIdentity.user_id,
    candidateCount: 0,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    matched: {
      appliedCandidate: false,
      assistantReplied: false,
      auditCandidateRecorded: false,
      auditRunCompleted: false,
      memoryPersisted: false,
    },
    memoryCount: 0,
    passed: false,
    runId,
  };

  const application = createApplication({
    a2aCoordinatorDbPath: a2aDbPath,
    defaultProviderId: 'codex-cli',
    memoryIngestionLlm: new OpenAICompatibleClient({
      apiKey: env.KAGURA_MEMORY_RECONCILER_API_KEY,
      baseUrl: process.env.KAGURA_MEMORY_RECONCILER_BASE_URL ?? 'https://api.deepseek.com',
      maxTokens: Number(process.env.KAGURA_MEMORY_RECONCILER_MAX_TOKENS ?? 1024),
      model: process.env.KAGURA_MEMORY_RECONCILER_MODEL ?? 'deepseek-v4-flash',
      timeoutMs: Number(process.env.KAGURA_MEMORY_RECONCILER_TIMEOUT_MS ?? 30_000),
    }),
    sessionDbPath: dbPath,
  });
  let caughtError: unknown;

  try {
    await application.start();
    await delay(3_000);

    const finalMarker = `HOST_MEMORY_INGESTION_OK ${runId}`;
    const memoryMarker = `HOST_MEMORY_INGESTION_MEMORY ${runId}`;
    const rootMessage = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: [
        `<@${botIdentity.user_id}> HOST_MEMORY_INGESTION_E2E ${runId}`,
        'Do not call save_memory, recall_memory, kagura-memory, or any other tool.',
        `Reply with exactly this single sentence: "${finalMarker} Durable memory decision: ${memoryMarker} the user wants Agent memory tools limited to save_memory and recall_memory only."`,
      ].join(' '),
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

      const reply = findReplyWithMarker(replies, rootMessage.ts, finalMarker);
      if (reply) {
        result.assistantReplyText = reply.text;
        result.assistantReplyTs = reply.ts;
        result.matched.assistantReplied = true;
      }

      const snapshot = readIngestionSnapshot(dbPath, runId);
      if (snapshot.runStatus) {
        result.ingestionRunStatus = snapshot.runStatus;
      } else {
        delete result.ingestionRunStatus;
      }
      result.candidateCount = snapshot.candidateCount;
      result.memoryCount = snapshot.memoryCount;
      result.matched.auditRunCompleted = snapshot.runStatus === 'completed';
      result.matched.auditCandidateRecorded = snapshot.candidateCount > 0;
      result.matched.appliedCandidate = snapshot.appliedCandidateCount > 0;
      result.matched.memoryPersisted = snapshot.memoryCount > 0;

      if (
        result.matched.assistantReplied &&
        result.matched.auditRunCompleted &&
        result.matched.auditCandidateRecorded &&
        result.matched.appliedCandidate &&
        result.matched.memoryPersisted
      ) {
        break;
      }

      await delay(2_500);
    }

    await writeResult(env.SLACK_E2E_RESULT_PATH, result);
    assertResult(result);
    result.passed = true;
    await writeResult(env.SLACK_E2E_RESULT_PATH, result);

    console.info('Live host memory ingestion E2E passed.');
    console.info('Root thread: %s', result.rootMessageTs);
    console.info('Assistant reply: %s', result.assistantReplyTs);
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error);
    caughtError = error;
  } finally {
    await writeResult(env.SLACK_E2E_RESULT_PATH, result).catch((error) => {
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

function readIngestionSnapshot(
  dbPath: string,
  runId: string,
): {
  appliedCandidateCount: number;
  candidateCount: number;
  memoryCount: number;
  runStatus?: string | undefined;
} {
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    const run = sqlite
      .prepare(
        `
          SELECT execution_id AS executionId, id, status
          FROM memory_ingestion_runs
          WHERE input LIKE ?
          ORDER BY started_at DESC
          LIMIT 1
        `,
      )
      .get(`%${runId}%`) as { executionId: string; id: string; status: string } | undefined;

    if (!run) {
      return { appliedCandidateCount: 0, candidateCount: 0, memoryCount: 0 };
    }

    const candidateCount = sqlite
      .prepare('SELECT COUNT(*) AS value FROM memory_ingestion_candidates WHERE run_id = ?')
      .get(run.id) as { value: number };
    const appliedCandidateCount = sqlite
      .prepare(
        "SELECT COUNT(*) AS value FROM memory_ingestion_candidates WHERE run_id = ? AND status = 'applied'",
      )
      .get(run.id) as { value: number };
    const memoryCount = sqlite
      .prepare('SELECT COUNT(*) AS value FROM memories WHERE metadata LIKE ?')
      .get(`%"executionId":"${run.executionId}"%`) as { value: number };

    return {
      appliedCandidateCount: appliedCandidateCount.value,
      candidateCount: candidateCount.value,
      memoryCount: memoryCount.value,
      runStatus: run.status,
    };
  } finally {
    sqlite.close();
  }
}

function findReplyWithMarker(
  replies: SlackConversationRepliesResponse,
  rootMessageTs: string,
  marker: string,
): { text: string; ts: string } | undefined {
  return replies.messages?.find((message) => {
    if (!message.ts || message.ts === rootMessageTs) return false;
    return typeof message.text === 'string' && message.text.includes(marker);
  }) as { text: string; ts: string } | undefined;
}

function assertResult(result: HostMemoryIngestionResult): void {
  const failures: string[] = [];

  if (!result.matched.assistantReplied) {
    failures.push('assistant did not reply with host memory ingestion marker');
  }
  if (!result.matched.auditRunCompleted) {
    failures.push(
      `memory ingestion audit run did not complete; status=${result.ingestionRunStatus}`,
    );
  }
  if (!result.matched.auditCandidateRecorded) {
    failures.push('memory ingestion did not record any candidates');
  }
  if (!result.matched.appliedCandidate) {
    failures.push('memory ingestion did not apply any high-confidence candidate');
  }
  if (!result.matched.memoryPersisted) {
    failures.push('memory ingestion did not persist a memory linked to the execution metadata');
  }

  if (failures.length > 0) {
    throw new Error(`Live host memory ingestion E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(
  resultPathTemplate: string,
  result: HostMemoryIngestionResult,
): Promise<void> {
  const absolutePath = e2ePath(resultPathTemplate, 'host-memory-ingestion-result.json');
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

function e2ePath(resultPathTemplate: string, fileName: string): string {
  return path.resolve(process.cwd(), resultPathTemplate.replace(/result\.json$/, fileName));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export const scenario: LiveE2EScenario = {
  id: 'host-memory-ingestion',
  provider: {
    kind: 'specific',
    providerId: 'codex-cli',
    reason: 'Uses Codex to produce the final reply for host memory ingestion.',
  },
  title: 'Host Memory Ingestion',
  description:
    'Verify a completed final assistant reply is extracted into memory by the host-side ingestion service and audited.',
  keywords: ['memory', 'ingestion', 'host', 'final-reply', 'deepseek', 'audit'],
  run: main,
};

runDirectly(scenario);
