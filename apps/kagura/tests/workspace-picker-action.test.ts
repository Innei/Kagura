import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ClaudeAgentSdkExecutor } from '~/agent/providers/claude-code/adapter.js';
import type { SessionAnalyticsStore } from '~/analytics/types.js';
import type { AppLogger } from '~/logger/index.js';
import type { MemoryStore } from '~/memory/types.js';
import type { SessionRecord, SessionStore } from '~/session/types.js';
import { SlackThreadContextLoader } from '~/slack/context/thread-context-loader.js';
import { createThreadExecutionRegistry } from '~/slack/execution/thread-execution-registry.js';
import {
  createThreadReplyHandler,
  WORKSPACE_PICKER_ACTION_ID,
} from '~/slack/ingress/app-mention-handler.js';
import { SlackUserInputBridge } from '~/slack/interaction/user-input-bridge.js';
import { WORKSPACE_MODAL_CALLBACK_ID } from '~/slack/interactions/workspace-message-action.js';
import { createWorkspacePickerActionHandler } from '~/slack/interactions/workspace-picker-action.js';
import { encodeWorkspacePickerButtonValue } from '~/slack/interactions/workspace-picker-payload.js';
import { SlackRenderer } from '~/slack/render/slack-renderer.js';
import type { SlackBlock, SlackWebClientLike } from '~/slack/types.js';
import { WorkspaceResolver } from '~/workspace/resolver.js';

const sdkMocks = vi.hoisted(() => ({
  env: (() => {
    process.env.REPO_ROOT_DIR = process.env.REPO_ROOT_DIR ?? '/tmp';
    process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? 'xoxb-test';
    process.env.SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN ?? 'xapp-test';
    process.env.SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET ?? 'secret';
    return true;
  })(),
  createSdkMcpServer: vi.fn((config: unknown) => config),
  query: vi.fn(),
  tool: vi.fn(
    (
      name: unknown,
      description: unknown,
      inputSchema: unknown,
      handler: unknown,
    ): Record<string, unknown> => ({
      description,
      handler,
      inputSchema,
      name,
    }),
  ),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: sdkMocks.createSdkMcpServer,
  query: sdkMocks.query,
  tool: sdkMocks.tool,
}));

describe('Workspace picker action test', () => {
  beforeEach(() => {
    sdkMocks.createSdkMcpServer.mockClear();
    sdkMocks.query.mockReset();
    sdkMocks.tool.mockClear();
  });

  it('posts a green button for ambiguous resolution and opens modal on click', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-picker-'));
    const repo1Path = path.join(repoRoot, 'org1', 'my-app');
    const repo2Path = path.join(repoRoot, 'org2', 'my-app');
    fs.mkdirSync(path.join(repo1Path, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo2Path, '.git'), { recursive: true });

    const logger = createTestLogger();
    const memoryStore = createMemoryStore();
    const sessionStore = createMemorySessionStore();
    const renderer = new SlackRenderer(logger);
    const threadContextLoader = new SlackThreadContextLoader(logger);
    const userInputBridge = new SlackUserInputBridge(logger);
    const workspaceResolver = new WorkspaceResolver({ repoRootDir: repoRoot, scanDepth: 3 });
    const channelPreferenceStore = { get: vi.fn().mockReturnValue(undefined), upsert: vi.fn() };
    const executor = new ClaudeAgentSdkExecutor(logger, memoryStore, channelPreferenceStore);
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
    const pickerHandler = createWorkspacePickerActionHandler(deps);
    const { ackCalls, client, postMessageCalls, viewOpenCalls } = createSlackClientFixture();

    await messageHandler({
      client,
      event: {
        channel: 'C123',
        team: 'T123',
        text: '<@U_BOT> work on my-app',
        ts: '1712345678.000100',
        type: 'message',
        user: 'U123',
      },
    });

    expect(sdkMocks.query).not.toHaveBeenCalled();
    expect(postMessageCalls).toHaveLength(1);

    const pickerMessage = postMessageCalls[0]!;
    expect(pickerMessage.thread_ts).toBe('1712345678.000100');
    expect(pickerMessage.text).toContain("couldn't tell which repository");
    expect(pickerMessage.text).toContain('org1/my-app');
    expect(pickerMessage.text).toContain('org2/my-app');

    const pickerBlocks = pickerMessage.blocks as SlackBlock[] | undefined;
    const actionsBlock = pickerBlocks?.find((block: SlackBlock) => block.type === 'actions');
    expect(actionsBlock).toBeDefined();
    expect(actionsBlock!.type).toBe('actions');

    const elements = (actionsBlock as unknown as { elements: Array<Record<string, unknown>> })
      .elements;
    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({
      action_id: WORKSPACE_PICKER_ACTION_ID,
      style: 'primary',
      type: 'button',
      value: encodeWorkspacePickerButtonValue('<@U_BOT> work on my-app'),
    });

    await pickerHandler({
      ack: async () => {
        ackCalls.push('picker');
      },
      body: {
        actions: [
          {
            action_id: WORKSPACE_PICKER_ACTION_ID,
            value: encodeWorkspacePickerButtonValue('<@U_BOT> work on my-app'),
          },
        ],
        channel: { id: 'C123' },
        message: {
          thread_ts: '1712345678.000100',
          ts: '1712345678.000200',
        },
        team: { id: 'T123' },
        trigger_id: 'trigger-picker-1',
        user: { id: 'U123' },
      },
      client,
    });

    expect(ackCalls).toContain('picker');
    expect(viewOpenCalls).toHaveLength(1);
    const openedPickerView = viewOpenCalls[0]!;
    expect(openedPickerView.trigger_id).toBe('trigger-picker-1');
    expect((openedPickerView.view as { callback_id?: string }).callback_id).toBe(
      WORKSPACE_MODAL_CALLBACK_ID,
    );

    const modalView = openedPickerView.view as { blocks?: unknown[]; private_metadata?: string };
    expect(modalView.private_metadata).toBeDefined();
    const metadata = JSON.parse(modalView.private_metadata!);
    expect(metadata.channelId).toBe('C123');
    expect(metadata.teamId).toBe('T123');
    expect(metadata.userId).toBe('U123');
  });

  it('proceeds without workspace when resolution is missing', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-picker-missing-'));
    const repoPath = path.join(repoRoot, 'actual-repo');
    fs.mkdirSync(path.join(repoPath, '.git'), { recursive: true });

    sdkMocks.query.mockReturnValue(
      (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'ses-1', model: 'test', cwd: '/tmp' };
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Hello! How can I help?' }] },
        };
        yield { type: 'result', subtype: 'success', duration_ms: 100, total_cost_usd: 0 };
      })(),
    );

    const logger = createTestLogger();
    const memoryStore = createMemoryStore();
    const sessionStore = createMemorySessionStore();
    const renderer = new SlackRenderer(logger);
    const threadContextLoader = new SlackThreadContextLoader(logger);
    const userInputBridge = new SlackUserInputBridge(logger);
    const workspaceResolver = new WorkspaceResolver({ repoRootDir: repoRoot, scanDepth: 2 });
    const channelPreferenceStore = { get: vi.fn().mockReturnValue(undefined), upsert: vi.fn() };
    const executor = new ClaudeAgentSdkExecutor(logger, memoryStore, channelPreferenceStore);
    const handler = createThreadReplyHandler({
      analyticsStore: { upsert: vi.fn() } as unknown as SessionAnalyticsStore,
      channelPreferenceStore,
      claudeExecutor: executor,
      logger,
      memoryStore,
      renderer,
      sessionStore,
      threadContextLoader,
      threadExecutionRegistry: createThreadExecutionRegistry(),
      userInputBridge,
      workspaceResolver,
    });
    const { client, postMessageCalls } = createSlackClientFixture();

    await handler({
      client,
      event: {
        channel: 'C123',
        team: 'T123',
        text: '<@U_BOT> hello, how are you?',
        ts: '1712345678.000100',
        type: 'message',
        user: 'U123',
      },
    });

    expect(sdkMocks.query).toHaveBeenCalledTimes(1);

    const firstQueryCall = sdkMocks.query.mock.calls[0];
    expect(firstQueryCall).toBeDefined();
    const queryArgs = firstQueryCall![0] as { options: { cwd?: string } };
    expect(queryArgs.options.cwd).toBeUndefined();

    const replyMessages = postMessageCalls.filter((msg) => !msg.text.includes("couldn't"));
    expect(replyMessages.length).toBeGreaterThanOrEqual(1);
    expect(replyMessages.some((msg) => msg.text.includes('Hello! How can I help?'))).toBe(true);
  });
});

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

function createMemoryStore(): MemoryStore {
  return {
    applyReconcileOps: () => ({ appliedOps: [] }),
    getDirtyBuckets: () => [],
    countAll: () => 0,
    countByCategory: () => 0,
    delete: () => false,
    deleteAll: () => 0,
    listRecent: () => [],
    listForContext: () => ({ global: [], workspace: [], preferences: [] }),
    prune: () => 0,
    pruneAll: () => 0,
    save: (input) => ({
      ...input,
      scope: input.repoId ? ('workspace' as const) : ('global' as const),
      createdAt: new Date().toISOString(),
      id: 'memory-1',
    }),
    search: () => [],
  };
}

function createSlackClientFixture(): {
  ackCalls: unknown[];
  client: SlackWebClientLike;
  postMessageCalls: Array<Parameters<SlackWebClientLike['chat']['postMessage']>[0]>;
  statusCalls: Array<{
    channel_id: string;
    status: string;
    thread_ts: string;
  }>;
  viewOpenCalls: Array<{ trigger_id: string; view: unknown }>;
} {
  const ackCalls: unknown[] = [];
  const postMessageCalls: Array<Parameters<SlackWebClientLike['chat']['postMessage']>[0]> = [];
  const statusCalls: Array<{
    channel_id: string;
    status: string;
    thread_ts: string;
  }> = [];
  const viewOpenCalls: Array<{ trigger_id: string; view: unknown }> = [];

  const client: SlackWebClientLike = {
    apiCall: async (method, args) => {
      if (method === 'agents.sessions.setStatus') {
        statusCalls.push(args as (typeof statusCalls)[number]);
      }
      return {};
    },
    auth: {
      test: async () => ({ user: 'kagura', user_id: 'U_BOT' }),
    },
    chat: {
      delete: async () => ({}),
      postMessage: async (args) => {
        postMessageCalls.push(args);
        return { ts: '1712345678.000200' };
      },
      update: async () => ({}),
    },
    conversations: {
      replies: async (args) => ({
        messages: [
          {
            text: '<@U_BOT> work on my-app',
            thread_ts: args.ts,
            ts: args.ts,
            user: 'U123',
          },
        ],
      }),
    },
    reactions: {
      add: async () => ({}),
      remove: async () => ({}),
    },
    files: {
      uploadV2: async () => ({ files: [{ id: 'F1' }] }),
    },
    views: {
      open: async (args) => {
        viewOpenCalls.push(args);
        return {};
      },
      publish: async () => ({}),
    },
  };

  return {
    ackCalls,
    client,
    postMessageCalls,
    statusCalls,
    viewOpenCalls,
  };
}
