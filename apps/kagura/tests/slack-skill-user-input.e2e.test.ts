import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { AgentExecutionRequest, AgentExecutionSink, AgentExecutor } from '~/agent/types.js';
import type { SessionAnalyticsStore } from '~/analytics/types.js';
import type { AppLogger } from '~/logger/index.js';
import type { ContextMemories, MemoryStore } from '~/memory/types.js';
import type { SessionRecord, SessionStore } from '~/session/types.js';
import { SlackThreadContextLoader } from '~/slack/context/thread-context-loader.js';
import { createThreadExecutionRegistry } from '~/slack/execution/thread-execution-registry.js';
import { createThreadReplyHandler } from '~/slack/ingress/app-mention-handler.js';
import { SlackUserInputBridge } from '~/slack/interaction/user-input-bridge.js';
import { SlackRenderer } from '~/slack/render/slack-renderer.js';
import type { SlackWebClientLike } from '~/slack/types.js';
import { WorkspaceResolver } from '~/workspace/resolver.js';

describe('Slack skill user input bridge', () => {
  it('routes AskUserQuestion-style prompts through Slack thread replies', async () => {
    const threadTs = '1712345678.000100';
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-root-'));
    const repoPath = path.join(repoRoot, 'kagura');
    fs.mkdirSync(path.join(repoPath, '.git'), { recursive: true });

    const logger = createTestLogger();
    const sessionStore = createMemorySessionStore();
    const memoryStore = createMemoryStoreFixture();
    const renderer = new SlackRenderer(logger);
    const threadContextLoader = new SlackThreadContextLoader(logger);
    const userInputBridge = new SlackUserInputBridge(logger);
    const workspaceResolver = new WorkspaceResolver({ repoRootDir: repoRoot, scanDepth: 2 });
    const executor = createInteractiveExecutor();
    const deps = {
      analyticsStore: { upsert: vi.fn() } as unknown as SessionAnalyticsStore,
      channelPreferenceStore: { get: vi.fn().mockReturnValue(undefined), upsert: vi.fn() },
      claudeExecutor: executor,
      logger,
      memoryStore,
      renderer,
      sessionStore,
      threadContextLoader,
      threadExecutionRegistry: createThreadExecutionRegistry(),
      userInputBridge,
      workspaceResolver,
    };

    const messageHandler = createThreadReplyHandler(deps);
    const threadReplyHandler = createThreadReplyHandler(deps);
    const { client, postMessageCalls, statusCalls } = createSlackClientFixture({ threadTs });

    const mentionTask = messageHandler({
      client,
      event: {
        channel: 'C123',
        team: 'T123',
        text: '<@U_BOT> run the bazi skill in kagura',
        ts: threadTs,
        type: 'message',
        user: 'U123',
      },
    });

    await vi.waitFor(() =>
      expect(postMessageCalls.some((call) => call.text.includes('Skill 需要你的输入'))).toBe(true),
    );
    expect(statusCalls.at(-1)).toEqual({
      channel_id: 'C123',
      status: 'suspended',
      thread_ts: threadTs,
    });

    await threadReplyHandler({
      client,
      event: {
        channel: 'C123',
        team: 'T123',
        text: '2',
        thread_ts: threadTs,
        ts: '1712345678.000200',
        type: 'message',
        user: 'U123',
      },
    });

    await mentionTask;

    expect(postMessageCalls.map((call) => call.text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Which calendar should I use?'),
        '已收到选择：Lunar。',
      ]),
    );
    expect(statusCalls.at(-1)).toEqual({
      channel_id: 'C123',
      status: 'active',
      thread_ts: threadTs,
    });
  });
});

function createInteractiveExecutor(): AgentExecutor {
  return {
    providerId: 'claude-code',
    drain: async () => {},
    async execute(_request: AgentExecutionRequest, sink: AgentExecutionSink): Promise<void> {
      await sink.onEvent({
        phase: 'started',
        resumeHandle: 'session-user-input',
        type: 'lifecycle',
      });

      const response = await sink.requestUserInput?.({
        questions: [
          {
            header: 'Calendar',
            options: [
              {
                description: 'Use Gregorian calendar data',
                label: 'Gregorian',
              },
              {
                description: 'Use lunar calendar data',
                label: 'Lunar',
              },
            ],
            question: 'Which calendar should I use?',
          },
        ],
      });

      await sink.onEvent({
        text: `已收到选择：${response?.answers['Which calendar should I use?'] ?? 'unknown'}。`,
        type: 'assistant-message',
      });
      await sink.onEvent({
        phase: 'completed',
        resumeHandle: 'session-user-input',
        type: 'lifecycle',
      });
    },
  };
}

function createTestLogger(): AppLogger {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
    withTag: vi.fn(),
  };

  logger.withTag.mockReturnValue(logger);

  return logger as unknown as AppLogger;
}

function createMemoryStoreFixture(): MemoryStore {
  const emptyContext: ContextMemories = {
    global: [],
    preferences: [],
    workspace: [],
  };

  return {
    applyReconcileOps: () => ({ appliedOps: [] }),
    getDirtyBuckets: () => [],
    countAll: () => 0,
    countByCategory: () => 0,
    delete: () => false,
    deleteAll: () => 0,
    listForContext: () => emptyContext,
    listRecent: () => [],
    prune: () => 0,
    pruneAll: () => 0,
    save: (input) => ({
      category: input.category,
      content: input.content,
      createdAt: new Date(0).toISOString(),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      id: 'memory-1',
      ...(input.metadata ? { metadata: input.metadata } : {}),
      ...(input.repoId ? { repoId: input.repoId } : {}),
      scope: input.repoId ? 'workspace' : 'global',
      ...(input.threadTs ? { threadTs: input.threadTs } : {}),
    }),
    search: () => [],
  };
}

function createMemorySessionStore(): SessionStore {
  const records = new Map<string, SessionRecord>();

  return {
    countAll: () => records.size,
    get: (threadTs) => {
      const existing = records.get(threadTs);
      return existing ? { ...existing } : undefined;
    },
    patch: (threadTs, patch) => {
      const existing = records.get(threadTs);
      if (!existing) {
        return undefined;
      }

      const next: SessionRecord = {
        ...existing,
        ...patch,
        threadTs,
        updatedAt: new Date().toISOString(),
      };
      records.set(threadTs, next);
      return { ...next };
    },
    upsert: (record) => {
      const next = { ...record };
      records.set(record.threadTs, next);
      return { ...next };
    },
  };
}

function createSlackClientFixture({ threadTs }: { threadTs: string }): {
  client: SlackWebClientLike;
  postMessageCalls: Array<{ channel: string; text: string; thread_ts?: string }>;
  statusCalls: Array<{
    channel_id: string;
    status: string;
    thread_ts: string;
  }>;
} {
  const postMessageCalls: Array<{ channel: string; text: string; thread_ts?: string }> = [];
  const statusCalls: Array<{
    channel_id: string;
    status: string;
    thread_ts: string;
  }> = [];

  const client: SlackWebClientLike = {
    apiCall: async (method, args) => {
      if (method === 'agents.sessions.setStatus') {
        statusCalls.push(args as (typeof statusCalls)[number]);
      }
      return {};
    },
    auth: {
      test: async () => ({ user_id: 'U_BOT' }),
    },
    chat: {
      delete: async () => ({}),
      postMessage: async (args) => {
        postMessageCalls.push(args);
        return { ts: '1712345678.000300' };
      },
      update: async () => ({}),
    },
    conversations: {
      replies: async () => ({
        messages: [
          {
            channel: 'C123',
            text: '<@U_BOT> run the bazi skill in kagura',
            thread_ts: threadTs,
            ts: threadTs,
            user: 'U123',
          },
        ],
      }),
    },
    files: {
      uploadV2: async () => ({ files: [] }),
    },
    reactions: {
      add: async () => ({}),
      remove: async () => ({}),
    },
    views: {
      open: async () => ({}),
      publish: async () => ({}),
    },
  };

  return {
    client,
    postMessageCalls,
    statusCalls,
  };
}
