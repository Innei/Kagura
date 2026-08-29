import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ClaudeAgentSdkExecutor } from '~/agent/providers/claude-code/adapter.js';
import { RECALL_MEMORY_TOOL_NAME } from '~/agent/providers/claude-code/tools/recall-memory.js';
import { SAVE_MEMORY_TOOL_NAME } from '~/agent/providers/claude-code/tools/save-memory.js';
import { UPLOAD_SLACK_FILE_TOOL_NAME } from '~/agent/providers/claude-code/tools/upload-slack-file.js';
import type { AgentExecutionEvent, AgentExecutionRequest } from '~/agent/types.js';
import type { SessionAnalyticsStore } from '~/analytics/types.js';
import type { ChannelPreferenceStore } from '~/channel-preference/types.js';
import type { AppLogger } from '~/logger/index.js';
import type { MemoryStore } from '~/memory/types.js';
import type { SessionRecord, SessionStore } from '~/session/types.js';
import { SlackThreadContextLoader } from '~/slack/context/thread-context-loader.js';
import { createThreadExecutionRegistry } from '~/slack/execution/thread-execution-registry.js';
import { createThreadReplyHandler } from '~/slack/ingress/app-mention-handler.js';
import { SlackUserInputBridge } from '~/slack/interaction/user-input-bridge.js';
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

describe('Slack loading status test', () => {
  beforeEach(() => {
    sdkMocks.createSdkMcpServer.mockClear();
    sdkMocks.query.mockReset();
    sdkMocks.tool.mockClear();
  });

  it('renders Claude SDK task and stream progress into Slack status updates', async () => {
    const threadTs = '1712345678.000100';
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-root-'));
    const repoPath = path.join(repoRoot, 'kagura');
    fs.mkdirSync(path.join(repoPath, '.git'), { recursive: true });
    const logger = createTestLogger();
    const memoryStore = createMemoryStore();
    const sessionStore = createMemorySessionStore();
    const renderer = new SlackRenderer(logger);
    const threadContextLoader = new SlackThreadContextLoader(logger);
    const userInputBridge = new SlackUserInputBridge(logger);
    const workspaceResolver = new WorkspaceResolver({ repoRootDir: repoRoot, scanDepth: 2 });
    const channelPreferenceStore = createChannelPreferenceStore();
    const executor = new ClaudeAgentSdkExecutor(logger, memoryStore, channelPreferenceStore);
    const handler = createThreadReplyHandler({
      analyticsStore: createAnalyticsStore(),
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
    const {
      client,
      deleteCalls,
      postMessageCalls,
      reactionCalls,
      removeReactionCalls,
      statusCalls,
      updateCalls,
    } = createSlackClientFixture({ threadTs });

    sdkMocks.query.mockImplementation(
      (_request: { prompt: string; options: Record<string, unknown> }) =>
        createMessageStream([
          {
            type: 'system',
            subtype: 'init',
            cwd: repoPath,
            model: 'claude-sonnet-test',
            session_id: 'session-1',
          },
          {
            type: 'system',
            subtype: 'session_state_changed',
            state: 'running',
          },
          {
            type: 'system',
            subtype: 'task_started',
            task_id: 'task-1',
            description: 'Inspect the Slack loading flow',
          },
          {
            type: 'system',
            subtype: 'task_progress',
            task_id: 'task-1',
            description: 'Inspect the Slack loading flow',
            last_tool_name: 'ReadFile',
            summary: 'Inspecting Slack renderer status handling',
            usage: {
              duration_ms: 900,
              tool_uses: 1,
              total_tokens: 42,
            },
          },
          {
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              index: 0,
              content_block: {
                type: 'tool_use',
                name: 'ReadFile',
              },
            },
            parent_tool_use_id: null,
            session_id: 'session-1',
            uuid: 'event-1',
          },
          {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'input_json_delta',
                partial_json: '{"path":"/tmp/kagura/src/slack/render/slack-renderer.ts"}',
              },
            },
            parent_tool_use_id: null,
            session_id: 'session-1',
            uuid: 'event-2',
          },
          {
            type: 'tool_progress',
            elapsed_time_seconds: 1.2,
            parent_tool_use_id: null,
            session_id: 'session-1',
            task_id: 'task-1',
            tool_name: 'ReadFile',
            tool_use_id: 'tool-1',
            uuid: 'tool-progress-1',
          },
          {
            type: 'stream_event',
            event: {
              type: 'content_block_stop',
              index: 0,
            },
            parent_tool_use_id: null,
            session_id: 'session-1',
            uuid: 'event-3',
          },
          {
            type: 'assistant',
            error: undefined,
            message: {
              content: [{ type: 'text', text: 'Updated loading messages.' }],
            },
            parent_tool_use_id: null,
            session_id: 'session-1',
            uuid: 'assistant-1',
          },
          {
            type: 'result',
            subtype: 'success',
            duration_ms: 1450,
            total_cost_usd: 0.0012,
          },
        ]),
    );

    await handler({
      client,
      event: {
        channel: 'C123',
        team: 'T123',
        text: '<@U_BOT> inspect the loading messages in kagura',
        ts: threadTs,
        type: 'message',
        user: 'U123',
      },
    });

    expect(sdkMocks.query).toHaveBeenCalledOnce();
    const [queryArgs] = sdkMocks.query.mock.calls[0] as [{ options: Record<string, unknown> }];
    expect(queryArgs.options).toMatchObject({
      agentProgressSummaries: true,
      cwd: repoPath,
      includeHookEvents: true,
      includePartialMessages: true,
    });

    expect(reactionCalls).toEqual([
      {
        channel: 'C123',
        name: 'eyes',
        timestamp: threadTs,
      },
      {
        channel: 'C123',
        name: 'white_check_mark',
        timestamp: threadTs,
      },
    ]);

    expect(removeReactionCalls).toEqual([
      {
        channel: 'C123',
        name: 'eyes',
        timestamp: threadTs,
      },
    ]);

    expect(statusCalls[0]).toMatchObject({
      channel_id: 'C123',
      status: 'processing',
      thread_ts: threadTs,
    });
    expect(statusCalls.at(-1)).toEqual(
      expect.objectContaining({
        channel_id: 'C123',
        status: 'active',
        thread_ts: threadTs,
      }),
    );

    expect(postMessageCalls).toHaveLength(2);
    const firstPost = postMessageCalls[0]!;
    expect(firstPost).toMatchObject({
      channel: 'C123',
      thread_ts: threadTs,
    });
    expect(firstPost.text).not.toBe('Working on your request... — Working on your request...');
    expect(
      (firstPost.blocks as SlackBlock[] | undefined)?.some((block) => block.type === 'plan'),
    ).toBe(false);
    expect(firstPost.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'context',
          elements: expect.arrayContaining([
            expect.objectContaining({ text: 'Inspect the Slack loading flow' }),
          ]),
        }),
      ]),
    );
    expect(updateCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: 'C123',
          text: expect.stringContaining('Running ReadFile'),
          ts: '1712345678.000200',
        }),
      ]),
    );
    expect(updateCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blocks: expect.arrayContaining([
            expect.objectContaining({
              type: 'context',
              elements: expect.arrayContaining([
                expect.objectContaining({ text: expect.stringContaining('Running') }),
              ]),
            }),
          ]),
          channel: 'C123',
          ts: '1712345678.000200',
        }),
      ]),
    );
    expect(updateCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: 'C123',
          text: expect.stringContaining('Inspect the Slack loading flow'),
          ts: '1712345678.000200',
        }),
      ]),
    );
    expect(postMessageCalls[1]).toEqual({
      blocks: [
        {
          elements: [{ text: '_Working in kagura_', type: 'mrkdwn' }],
          type: 'context',
        },
        {
          elements: [
            {
              elements: [{ text: 'Updated loading messages.', type: 'text' }],
              type: 'rich_text_section',
            },
          ],
          type: 'rich_text',
        },
      ],
      channel: 'C123',
      text: 'Updated loading messages.',
      thread_ts: threadTs,
    });
    expect(deleteCalls).toEqual([
      {
        channel: 'C123',
        ts: '1712345678.000200',
      },
    ]);

    expect(sessionStore.get(threadTs)?.providerSessionId).toBe('session-1');
  });

  it('emits stopped lifecycle when the executor abort signal fires', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-root-abort-'));
    const repoPath = path.join(repoRoot, 'kagura');
    fs.mkdirSync(path.join(repoPath, '.git'), { recursive: true });
    const ac = new AbortController();
    const logger = createTestLogger();
    const executor = new ClaudeAgentSdkExecutor(
      logger,
      createMemoryStore(),
      createChannelPreferenceStore(),
    );
    const events: AgentExecutionEvent[] = [];

    sdkMocks.query.mockImplementation(() =>
      createAbortAfterFirstMessageStream(ac.signal, repoPath),
    );

    const done = executor.execute(
      {
        ...createExecutionRequest(),
        workspacePath: repoPath,
        abortSignal: ac.signal,
      },
      {
        onEvent: async (event) => {
          events.push(event);
        },
      },
    );

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'lifecycle' && e.phase === 'started')).toBe(true);
    });
    await vi.waitFor(() => {
      expect(
        (logger.info as unknown as ReturnType<typeof vi.fn>).mock.calls.some((call: unknown[]) =>
          String(call[0]).includes('First Claude SDK message'),
        ),
      ).toBe(true);
    });
    ac.abort();
    await done;

    const lifecycle = events.filter(
      (e): e is Extract<AgentExecutionEvent, { type: 'lifecycle' }> => e.type === 'lifecycle',
    );
    expect(lifecycle.map((e) => e.phase)).toEqual(['started', 'stopped']);
    expect(lifecycle.some((e) => e.phase === 'failed')).toBe(false);
    expect(lifecycle[0]).toEqual({ type: 'lifecycle', phase: 'started' });
    expect(lifecycle[1]).toEqual({
      type: 'lifecycle',
      phase: 'stopped',
      reason: 'user_stop',
      resumeHandle: 'session-abort-test',
    });
  });

  it('interrupts the Claude SDK query before finalizing an aborted execution', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-root-abort-interrupt-'));
    const repoPath = path.join(repoRoot, 'kagura');
    fs.mkdirSync(path.join(repoPath, '.git'), { recursive: true });
    const ac = new AbortController();
    const logger = createTestLogger();
    const executor = new ClaudeAgentSdkExecutor(
      logger,
      createMemoryStore(),
      createChannelPreferenceStore(),
    );
    const events: AgentExecutionEvent[] = [];
    const interrupt = vi.fn(async () => {});

    sdkMocks.query.mockImplementation(() =>
      createInterruptiblePendingQuery(repoPath, {
        interrupt,
        sessionId: 'session-interrupt-test',
      }),
    );

    const done = executor.execute(
      {
        ...createExecutionRequest(),
        workspacePath: repoPath,
        abortSignal: ac.signal,
      },
      {
        onEvent: async (event) => {
          events.push(event);
        },
      },
    );

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'lifecycle' && e.phase === 'started')).toBe(true);
    });
    ac.abort('superseded');
    await done;

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({
      type: 'lifecycle',
      phase: 'stopped',
      reason: 'superseded',
      resumeHandle: 'session-interrupt-test',
    });
  });

  it('resolves without failed lifecycle when publishing stopped throws', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-root-abort-sink-'));
    const repoPath = path.join(repoRoot, 'kagura');
    fs.mkdirSync(path.join(repoPath, '.git'), { recursive: true });
    const ac = new AbortController();
    const logger = createTestLogger();
    const executor = new ClaudeAgentSdkExecutor(
      logger,
      createMemoryStore(),
      createChannelPreferenceStore(),
    );
    const events: AgentExecutionEvent[] = [];
    let stoppedPublishAttempts = 0;

    sdkMocks.query.mockImplementation(() =>
      createAbortAfterFirstMessageStream(ac.signal, repoPath),
    );

    const done = executor.execute(
      {
        ...createExecutionRequest(),
        workspacePath: repoPath,
        abortSignal: ac.signal,
      },
      {
        onEvent: async (event) => {
          if (event.type === 'lifecycle' && event.phase === 'stopped') {
            stoppedPublishAttempts += 1;
            throw new Error('sink stopped publish failed');
          }
          events.push(event);
        },
      },
    );

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'lifecycle' && e.phase === 'started')).toBe(true);
    });
    ac.abort();
    await expect(done).resolves.toBeUndefined();

    const lifecycle = events.filter(
      (e): e is Extract<AgentExecutionEvent, { type: 'lifecycle' }> => e.type === 'lifecycle',
    );
    expect(lifecycle.map((e) => e.phase)).toEqual(['started']);
    expect(lifecycle.some((e) => e.phase === 'failed')).toBe(false);
    expect(stoppedPublishAttempts).toBe(1);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('emits started then stopped when abort signal is already aborted before first next()', async () => {
    const ac = new AbortController();
    ac.abort();
    const executor = new ClaudeAgentSdkExecutor(
      createTestLogger(),
      createMemoryStore(),
      createChannelPreferenceStore(),
    );
    const events: AgentExecutionEvent[] = [];

    sdkMocks.query.mockImplementation(() => createMessageStream([]));

    await executor.execute(
      { ...createExecutionRequest(), abortSignal: ac.signal },
      {
        onEvent: async (event) => {
          events.push(event);
        },
      },
    );

    const lifecycle = events.filter(
      (e): e is Extract<AgentExecutionEvent, { type: 'lifecycle' }> => e.type === 'lifecycle',
    );
    expect(lifecycle.map((e) => e.phase)).toEqual(['started', 'stopped']);
    expect(lifecycle.some((e) => e.phase === 'failed')).toBe(false);
  });

  it('emits failed when the iterator rejects with a non-abort error', async () => {
    const executor = new ClaudeAgentSdkExecutor(
      createTestLogger(),
      createMemoryStore(),
      createChannelPreferenceStore(),
    );
    const events: AgentExecutionEvent[] = [];

    sdkMocks.query.mockImplementation(() =>
      createIterableFirstNextRejects(new Error('iterator boom')),
    );

    await executor.execute(createExecutionRequest(), {
      onEvent: async (event) => {
        events.push(event);
      },
    });

    const lifecycle = events.filter(
      (e): e is Extract<AgentExecutionEvent, { type: 'lifecycle' }> => e.type === 'lifecycle',
    );
    expect(lifecycle.map((e) => e.phase)).toEqual(['started', 'failed']);
    expect(lifecycle.some((e) => e.phase === 'stopped')).toBe(false);
    expect(lifecycle[1]).toMatchObject({
      type: 'lifecycle',
      phase: 'failed',
      error: 'iterator boom',
    });
  });

  it('cleans up the thread progress message when execution fails after cutover', async () => {
    const threadTs = '1712345678.000101';
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-root-'));
    const repoPath = path.join(repoRoot, 'kagura');
    fs.mkdirSync(path.join(repoPath, '.git'), { recursive: true });
    const logger = createTestLogger();
    const memoryStore = createMemoryStore();
    const sessionStore = createMemorySessionStore();
    const renderer = new SlackRenderer(logger);
    const threadContextLoader = new SlackThreadContextLoader(logger);
    const userInputBridge = new SlackUserInputBridge(logger);
    const workspaceResolver = new WorkspaceResolver({ repoRootDir: repoRoot, scanDepth: 2 });
    const channelPreferenceStore = createChannelPreferenceStore();
    const executor = new ClaudeAgentSdkExecutor(logger, memoryStore, channelPreferenceStore);
    const handler = createThreadReplyHandler({
      analyticsStore: createAnalyticsStore(),
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
    const { client, deleteCalls, postMessageCalls, statusCalls, updateCalls } =
      createSlackClientFixture({ threadTs });

    sdkMocks.query.mockImplementation(
      (_request: { prompt: string; options: Record<string, unknown> }) =>
        createFailingMessageStream(
          [
            {
              type: 'system',
              subtype: 'init',
              cwd: repoPath,
              model: 'claude-sonnet-test',
              session_id: 'session-2',
            },
            {
              type: 'system',
              subtype: 'task_started',
              task_id: 'task-2',
              description: 'Inspect failure cleanup',
            },
            {
              type: 'system',
              subtype: 'task_progress',
              task_id: 'task-2',
              description: 'Inspect failure cleanup',
              last_tool_name: 'ReadFile',
              summary: 'Inspecting failure cleanup handling',
              usage: {
                duration_ms: 600,
                tool_uses: 1,
                total_tokens: 24,
              },
            },
          ],
          new Error('boom'),
        ),
    );

    await handler({
      client,
      event: {
        channel: 'C123',
        team: 'T123',
        text: '<@U_BOT> inspect failure cleanup in kagura',
        ts: threadTs,
        type: 'message',
        user: 'U123',
      },
    });

    expect(statusCalls[0]).toMatchObject({
      channel_id: 'C123',
      status: 'processing',
      thread_ts: threadTs,
    });
    expect(statusCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel_id: 'C123',
          status: 'active',
          thread_ts: threadTs,
        }),
      ]),
    );

    expect(postMessageCalls[0]).toMatchObject({
      channel: 'C123',
      thread_ts: threadTs,
    });
    expect(updateCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: 'C123',
          text: expect.stringContaining('Inspect failure cleanup'),
          ts: '1712345678.000200',
        }),
      ]),
    );
    expect(postMessageCalls.at(-1)).toEqual({
      blocks: [
        {
          elements: [
            {
              elements: [{ text: 'Agent execution failed: boom', type: 'text' }],
              type: 'rich_text_section',
            },
          ],
          type: 'rich_text',
        },
      ],
      channel: 'C123',
      text: 'Agent execution failed: boom',
      thread_ts: threadTs,
    });
    expect(deleteCalls).toEqual([]);
    expect(updateCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: 'C123',
          text: expect.stringContaining('\u2705'),
          ts: '1712345678.000200',
        }),
      ]),
    );
  });

  it('returns a helpful message when recall_memory requests workspace scope without a workspace', async () => {
    const search = vi.fn(() => []);
    const memoryStore = {
      ...createMemoryStore(),
      search,
    };
    const { tools } = await getMcpToolsForRequest({}, memoryStore);

    const result = await getToolHandler(
      tools,
      RECALL_MEMORY_TOOL_NAME,
    )({
      scope: 'workspace',
    });

    expect(result).toEqual({
      content: [
        {
          text: 'No workspace is set. Use scope "global" to search global memories, or mention a repository to set a workspace.',
          type: 'text',
        },
      ],
    });
    expect(search).not.toHaveBeenCalled();
  });

  it('defaults save_memory to workspace scope when a workspace is configured', async () => {
    const save = vi.fn((input) => ({
      ...input,
      createdAt: new Date().toISOString(),
      id: 'memory-1',
      scope: 'workspace' as const,
    }));
    const memoryStore = {
      ...createMemoryStore(),
      save,
    };
    const { tools } = await getMcpToolsForRequest(
      {
        workspaceLabel: 'kagura',
        workspacePath: '/tmp/kagura',
        workspaceRepoId: 'repo-1',
      },
      memoryStore,
    );

    const result = await getToolHandler(
      tools,
      SAVE_MEMORY_TOOL_NAME,
    )({
      category: 'context',
      content: 'Remember this summary.',
    });

    expect(save).toHaveBeenCalledWith({
      category: 'context',
      content: 'Remember this summary.',
      repoId: 'repo-1',
      threadTs: '1712345678.000100',
    });
    expect(result).toEqual({
      content: [{ text: 'Memory saved (workspace): memory-1', type: 'text' }],
    });
  });

  it('queues a workspace file for Slack upload via upload_slack_file', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-tool-workspace-'));
    const nestedDir = path.join(workspacePath, 'artifacts');
    fs.mkdirSync(nestedDir, { recursive: true });
    const reportPath = path.join(nestedDir, 'report.txt');
    fs.writeFileSync(reportPath, 'artifact body', 'utf8');

    const { events, tools } = await getMcpToolsForRequest({
      workspaceLabel: 'upload-test',
      workspacePath,
      workspaceRepoId: 'repo-upload',
    });

    const result = await getToolHandler(
      tools,
      UPLOAD_SLACK_FILE_TOOL_NAME,
    )({
      path: 'artifacts/report.txt',
    });

    expect(result).toEqual({
      content: [{ text: 'Queued report.txt for Slack upload.', type: 'text' }],
    });
    expect(events).toContainEqual({
      type: 'generated-files',
      files: [
        {
          fileName: 'report.txt',
          path: fs.realpathSync(reportPath),
          providerFileId: 'manual-upload:artifacts/report.txt',
        },
      ],
    });
  });

  it('rejects upload_slack_file paths outside the current workspace root', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-tool-root-'));
    const outsidePath = path.join(os.tmpdir(), `outside-${Date.now()}.txt`);
    fs.writeFileSync(outsidePath, 'outside', 'utf8');

    const { events, tools } = await getMcpToolsForRequest({
      workspaceLabel: 'upload-test',
      workspacePath,
      workspaceRepoId: 'repo-upload',
    });

    const result = await getToolHandler(
      tools,
      UPLOAD_SLACK_FILE_TOOL_NAME,
    )({
      path: outsidePath,
    });

    expect(result).toEqual({
      content: [
        {
          text: expect.stringContaining('path must stay inside the current workspace/session root'),
          type: 'text',
        },
      ],
      isError: true,
    });
    expect(events.filter((event) => event.type === 'generated-files')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'generated-images')).toHaveLength(0);
  });

  it('routes image uploads through generated-images when upload_slack_file targets an image', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-tool-image-'));
    const imagePath = path.join(workspacePath, 'screens', 'preview.png');
    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    fs.writeFileSync(imagePath, 'png-data', 'utf8');

    const { events, tools } = await getMcpToolsForRequest({
      workspaceLabel: 'upload-test',
      workspacePath,
      workspaceRepoId: 'repo-upload',
    });

    const result = await getToolHandler(
      tools,
      UPLOAD_SLACK_FILE_TOOL_NAME,
    )({
      path: 'screens/preview.png',
    });

    expect(result).toEqual({
      content: [{ text: 'Queued preview.png for Slack upload.', type: 'text' }],
    });
    expect(events).toContainEqual({
      type: 'generated-images',
      files: [
        {
          fileName: 'preview.png',
          path: fs.realpathSync(imagePath),
          providerFileId: 'manual-upload:screens/preview.png',
        },
      ],
    });
  });
});

type CapturedMcpTool = {
  handler: (args: Record<string, unknown>) => Promise<unknown>;
  name: string;
};

async function getMcpToolsForRequest(
  overrides: Partial<AgentExecutionRequest> = {},
  memoryStore: MemoryStore = createMemoryStore(),
): Promise<{ events: AgentExecutionEvent[]; tools: CapturedMcpTool[] }> {
  sdkMocks.query.mockImplementation(() => {
    throw new Error('stop-after-mcp-server');
  });

  const executor = new ClaudeAgentSdkExecutor(
    createTestLogger(),
    memoryStore,
    createChannelPreferenceStore(),
  );
  const events: AgentExecutionEvent[] = [];

  await expect(
    executor.execute(createExecutionRequest(overrides), {
      onEvent: async (event) => {
        events.push(event);
      },
    }),
  ).rejects.toThrow('stop-after-mcp-server');

  const lastCreateMcpServerCall = sdkMocks.createSdkMcpServer.mock.calls.at(-1);
  const mcpServer = lastCreateMcpServerCall?.[0] as { tools: CapturedMcpTool[] } | undefined;
  expect(mcpServer).toBeDefined();

  return {
    events,
    tools: mcpServer!.tools,
  };
}

function getToolHandler(
  tools: CapturedMcpTool[],
  toolName: string,
): (args: Record<string, unknown>) => Promise<unknown> {
  const tool = tools.find((candidate) => candidate.name === toolName);
  expect(tool).toBeDefined();
  return tool!.handler;
}

function createExecutionRequest(
  overrides: Partial<AgentExecutionRequest> = {},
): AgentExecutionRequest {
  return {
    channelId: 'C123',
    mentionText: '<@U_BOT> inspect the loading messages in kagura',
    threadContext: {
      channelId: 'C123',
      fileLoadFailures: [],
      loadedFiles: [],
      messages: [],
      renderedPrompt: '',
      threadTs: '1712345678.000100',
      loadedImages: [],
      imageLoadFailures: [],
    },
    threadTs: '1712345678.000100',
    userId: 'U123',
    ...overrides,
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

function createAnalyticsStore(): SessionAnalyticsStore {
  return {
    getByModel: vi.fn().mockReturnValue([]),
    getOverview: vi.fn().mockReturnValue({
      avgDurationMs: 0,
      cacheHitRate: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      totalCostUSD: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalSessions: 0,
    }),
    getRecentSessions: vi.fn().mockReturnValue([]),
    upsert: vi.fn(),
  };
}

function createChannelPreferenceStore(): ChannelPreferenceStore {
  return {
    get: () => undefined,
    upsert: (channelId, defaultWorkspaceInput) => ({
      channelId,
      createdAt: new Date(0).toISOString(),
      defaultWorkspaceInput,
      updatedAt: new Date(0).toISOString(),
    }),
  };
}

function createSlackClientFixture({ threadTs }: { threadTs: string }): {
  client: SlackWebClientLike;
  deleteCalls: Array<{ channel: string; ts: string }>;
  postMessageCalls: Array<Parameters<SlackWebClientLike['chat']['postMessage']>[0]>;
  reactionCalls: Array<{ channel: string; name: string; timestamp: string }>;
  removeReactionCalls: Array<{ channel: string; name: string; timestamp: string }>;
  statusCalls: Array<{
    channel_id: string;
    status: string;
    thread_ts: string;
  }>;
  updateCalls: Array<{ blocks?: SlackBlock[]; channel: string; text: string; ts: string }>;
} {
  const deleteCalls: Array<{ channel: string; ts: string }> = [];
  const postMessageCalls: Array<Parameters<SlackWebClientLike['chat']['postMessage']>[0]> = [];
  const reactionCalls: Array<{ channel: string; name: string; timestamp: string }> = [];
  const removeReactionCalls: Array<{ channel: string; name: string; timestamp: string }> = [];
  const statusCalls: Array<{
    channel_id: string;
    status: string;
    thread_ts: string;
  }> = [];
  const updateCalls: Array<{ blocks?: SlackBlock[]; channel: string; text: string; ts: string }> =
    [];

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
      delete: async (args) => {
        deleteCalls.push(args);
        return {};
      },
      postMessage: async (args) => {
        postMessageCalls.push(args);
        return { ts: '1712345678.000200' };
      },
      update: async (args) => {
        updateCalls.push(args);
        return {};
      },
    },
    conversations: {
      replies: async () => ({
        messages: [
          {
            channel: 'C123',
            text: '<@U_BOT> inspect the loading messages in kagura',
            thread_ts: threadTs,
            ts: threadTs,
            user: 'U123',
          },
        ],
      }),
    },
    reactions: {
      add: async (args) => {
        reactionCalls.push(args);
        return {};
      },
      remove: async (args) => {
        removeReactionCalls.push(args);
        return {};
      },
    },
    files: {
      uploadV2: async () => ({ files: [{ id: 'F1' }] }),
    },
    views: {
      open: async () => ({}),
      publish: async () => ({}),
    },
  };

  return {
    client,
    deleteCalls,
    postMessageCalls,
    reactionCalls,
    removeReactionCalls,
    statusCalls,
    updateCalls,
  };
}

async function* createMessageStream(messages: readonly unknown[]): AsyncIterable<unknown> {
  for (const message of messages) {
    yield message;
  }
}

async function* createFailingMessageStream(
  messages: readonly unknown[],
  error: Error,
): AsyncIterable<unknown> {
  for (const message of messages) {
    yield message;
  }

  throw error;
}

function createIterableFirstNextRejects(err: Error): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          return Promise.reject(err);
        },
      };
    },
  };
}

async function* createAbortAfterFirstMessageStream(
  signal: AbortSignal,
  cwd: string,
): AsyncIterable<unknown> {
  yield {
    type: 'system',
    subtype: 'init',
    cwd,
    model: 'claude-sonnet-test',
    session_id: 'session-abort-test',
  };
  await new Promise<void>((_resolve, reject) => {
    const abortErr = (): void => {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      reject(err);
    };
    if (signal.aborted) {
      abortErr();
      return;
    }
    signal.addEventListener('abort', abortErr, { once: true });
  });
}

function createInterruptiblePendingQuery(
  cwd: string,
  options?: {
    interrupt?: (() => Promise<void> | void) | undefined;
    sessionId?: string | undefined;
  },
): AsyncIterable<unknown> & {
  interrupt: () => Promise<void>;
  next: () => Promise<IteratorResult<unknown>>;
  return: () => Promise<IteratorResult<unknown>>;
} {
  let yieldedInit = false;
  let resolvePending: ((value: IteratorResult<unknown>) => void) | undefined;
  const pending = new Promise<IteratorResult<unknown>>((resolve) => {
    resolvePending = resolve;
  });

  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async interrupt() {
      await options?.interrupt?.();
      resolvePending?.({ done: true, value: undefined });
    },
    async next() {
      if (!yieldedInit) {
        yieldedInit = true;
        return {
          done: false,
          value: {
            type: 'system',
            subtype: 'init',
            cwd,
            model: 'claude-sonnet-test',
            session_id: options?.sessionId ?? 'session-interrupt-test',
          },
        };
      }

      return pending;
    },
    async return() {
      resolvePending?.({ done: true, value: undefined });
      return { done: true, value: undefined };
    },
  };
}
