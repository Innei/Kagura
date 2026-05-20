import { describe, expect, it, vi } from 'vitest';

import type { AgentActivityState } from '~/agent/types.js';
import type { SessionAnalyticsStore } from '~/analytics/types.js';
import type { AppLogger } from '~/logger/index.js';
import type { SessionStore } from '~/session/types.js';
import { createActivitySink } from '~/slack/ingress/activity-sink.js';
import type { SlackPermissionBridge } from '~/slack/interaction/permission-bridge.js';
import type { SlackRenderer } from '~/slack/render/slack-renderer.js';
import type { SlackWebClientLike } from '~/slack/types.js';
import * as workspaceResolverModule from '~/workspace/resolver.js';

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

function createRendererStub(): SlackRenderer {
  return {
    addAcknowledgementReaction: vi.fn().mockResolvedValue(undefined),
    appendSessionUsageInfoToThreadReply: vi.fn().mockResolvedValue(true),
    clearUiState: vi.fn().mockResolvedValue(undefined),
    deleteThreadProgressMessage: vi.fn().mockResolvedValue(undefined),
    finalizeThreadProgressMessage: vi.fn().mockResolvedValue(undefined),
    postGeneratedFiles: vi.fn().mockResolvedValue([]),
    postGeneratedImages: vi.fn().mockResolvedValue([]),
    finalizeThreadProgressMessageStopped: vi.fn().mockResolvedValue(undefined),
    postThreadReply: vi.fn().mockResolvedValue(undefined),
    updateThreadReplyWorkspaceContext: vi.fn().mockResolvedValue(undefined),
    setUiState: vi.fn().mockResolvedValue(undefined),
    showThinkingIndicator: vi.fn().mockResolvedValue(undefined),
    upsertThreadProgressMessage: vi.fn().mockResolvedValue('progress-ts'),
    postSessionUsageInfo: vi.fn().mockResolvedValue(undefined),
  } as unknown as SlackRenderer;
}

function createMockClient(): SlackWebClientLike {
  return {
    assistant: { threads: { setStatus: vi.fn().mockResolvedValue({}) } },
    auth: { test: vi.fn().mockResolvedValue({ user_id: 'U_BOT' }) },
    chat: {
      delete: vi.fn().mockResolvedValue({}),
      postMessage: vi.fn().mockResolvedValue({ ts: 'msg-ts' }),
      update: vi.fn().mockResolvedValue({}),
    },
    conversations: { replies: vi.fn().mockResolvedValue({ messages: [] }) },
    files: { uploadV2: vi.fn().mockResolvedValue({ files: [{ id: 'F1' }] }) },
    reactions: {
      add: vi.fn().mockResolvedValue({}),
      remove: vi.fn().mockResolvedValue({}),
    },
    views: {
      open: vi.fn().mockResolvedValue({}),
      publish: vi.fn().mockResolvedValue({}),
    },
  } as unknown as SlackWebClientLike;
}

function createMockSessionStore(): SessionStore {
  return {
    countAll: () => 0,
    get: vi.fn().mockReturnValue(undefined),
    patch: vi.fn().mockReturnValue(undefined),
    upsert: vi.fn().mockImplementation((r) => r),
  } as unknown as SessionStore;
}

function createMockAnalyticsStore(): SessionAnalyticsStore {
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

describe('createActivitySink', () => {
  it('posts a thread reply on assistant-message events', async () => {
    const renderer = createRendererStub();
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    await sink.onEvent({ type: 'assistant-message', text: 'Hello!' });

    expect(renderer.postThreadReply).toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      'Hello!',
      expect.any(Object),
    );
  });

  it('exposes the final assistant text for host memory ingestion', async () => {
    const renderer = createRendererStub();
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    await sink.onEvent({ type: 'assistant-message', text: 'First reply' });
    await sink.onEvent({ type: 'assistant-message', text: 'Final reply' });

    expect(sink.finalAssistantText).toBe('Final reply');
  });

  it('uses the flushed quiet-final assistant text as the final assistant text', async () => {
    const renderer = createRendererStub();
    const sink = createActivitySink({
      assistantMessageVisibility: 'quiet-final',
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    await sink.onEvent({ type: 'assistant-message', text: 'Buffered quiet reply' });
    await sink.onEvent({ type: 'lifecycle', phase: 'completed' });
    await sink.finalize();

    expect(sink.finalAssistantText).toBe('Buffered quiet reply');
    expect(renderer.postThreadReply).toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      'Buffered quiet reply',
      expect.any(Object),
    );
  });

  it('clears UI state after assistant-message', async () => {
    const renderer = createRendererStub();
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    await sink.onEvent({ type: 'assistant-message', text: 'Hello!' });

    expect(renderer.clearUiState).toHaveBeenCalled();
  });

  it('buffers quiet A2A assistant messages and posts only the final one on completion', async () => {
    const renderer = createRendererStub();
    const recorder = { record: vi.fn().mockResolvedValue(undefined) };
    const sink = createActivitySink({
      assistantMessageVisibility: 'quiet-final',
      channel: 'C123',
      client: createMockClient(),
      executionId: 'exec-1',
      logger: createTestLogger(),
      logLabel: 'A2A thread reply',
      quietAssistantMessageRecorder: recorder,
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
      userId: 'U123',
    });

    await sink.onEvent({ type: 'assistant-message', text: 'I will inspect the repo.' });
    await sink.onEvent({ type: 'assistant-message', text: 'Final answer.' });

    expect(renderer.postThreadReply).not.toHaveBeenCalled();
    expect(recorder.record).toHaveBeenCalledTimes(2);
    expect(recorder.record).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'C123',
        executionId: 'exec-1',
        logLabel: 'A2A thread reply',
        reason: 'quiet_final_buffered',
        text: 'I will inspect the repo.',
        threadTs: 'ts1',
        userId: 'U123',
      }),
    );

    await sink.onEvent({ type: 'lifecycle', phase: 'completed' });
    await sink.finalize();

    expect(renderer.postThreadReply).toHaveBeenCalledTimes(1);
    expect(renderer.postThreadReply).toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      'Final answer.',
      expect.any(Object),
    );
  });

  it('keeps quiet A2A delegation messages public when they mention a configured participant', async () => {
    const renderer = createRendererStub();
    const recorder = { record: vi.fn().mockResolvedValue(undefined) };
    const sink = createActivitySink({
      assistantMessageVisibility: 'quiet-final',
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      quietAssistantMessageRecorder: recorder,
      quietAssistantPublicMentionIds: ['U_HELPER'],
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    await sink.onEvent({ type: 'assistant-message', text: 'I will delegate this.' });
    await sink.onEvent({ type: 'assistant-message', text: '<@U_HELPER> please review this.' });

    expect(renderer.postThreadReply).toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      '<@U_HELPER> please review this.',
      expect.any(Object),
    );
    expect(recorder.record).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'I will delegate this.' }),
    );

    await sink.onEvent({ type: 'lifecycle', phase: 'completed' });
    await sink.finalize();

    expect(renderer.postThreadReply).toHaveBeenCalledTimes(1);
  });

  it('patches session with resume handle on lifecycle events', async () => {
    const sessionStore = createMockSessionStore();
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer: createRendererStub(),
      sessionStore,
      threadTs: 'ts1',
    });

    await sink.onEvent({ type: 'lifecycle', phase: 'started', resumeHandle: 'session-42' });

    expect(sessionStore.patch).toHaveBeenCalledWith('ts1', { providerSessionId: 'session-42' });
  });

  it('posts error message on lifecycle failed', async () => {
    const renderer = createRendererStub();
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    await sink.onEvent({ type: 'lifecycle', phase: 'failed', error: 'boom' });

    expect(renderer.postThreadReply).toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      'Agent execution failed: boom',
    );
  });

  it('redacts token-like values from lifecycle failed replies', async () => {
    const renderer = createRendererStub();
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    await sink.onEvent({
      type: 'lifecycle',
      phase: 'failed',
      error: 'request failed with Bearer abc.def.ghi and sk-ant-testtoken',
    });

    expect(renderer.postThreadReply).toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      'Agent execution failed: request failed with Bearer [REDACTED] and [REDACTED]',
    );
  });

  it('finalize clears UI state', async () => {
    const renderer = createRendererStub();
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    await sink.finalize();

    expect(renderer.clearUiState).toHaveBeenCalledWith(expect.anything(), 'C123', 'ts1');
  });

  it('tracks tool activity in toolHistory', async () => {
    const renderer = createRendererStub();
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    const state: AgentActivityState = {
      threadTs: 'ts1',
      status: 'Reading files...',
      activities: ['Reading src/index.ts...'],
      clear: false,
    };
    await sink.onEvent({ type: 'activity-state', state });

    expect(sink.toolHistory.get('Reading')).toBe(1);
  });

  it('publishes task updates through the progress message state', async () => {
    const renderer = createRendererStub();
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    await sink.onEvent({
      type: 'task-update',
      taskId: 'cmd-1',
      title: 'git status',
      status: 'in_progress',
      details: 'Checking repository state',
    });

    expect(renderer.upsertThreadProgressMessage).toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      expect.objectContaining({
        status: 'git status',
        tasks: [
          expect.objectContaining({
            taskId: 'cmd-1',
            title: 'git status',
            status: 'in_progress',
            details: 'Checking repository state',
          }),
        ],
      }),
      undefined,
    );
  });

  it('disables Slack task card blocks by default while keeping task progress', async () => {
    const renderer = createRendererStub();
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    await sink.onEvent({
      type: 'task-update',
      taskId: 'cmd-1',
      title: 'git status',
      status: 'in_progress',
      details: 'Checking repository state',
    });

    expect(renderer.upsertThreadProgressMessage).toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      expect.objectContaining({
        status: 'git status',
        taskCardBlocksEnabled: false,
        tasks: [
          expect.objectContaining({
            taskId: 'cmd-1',
            title: 'git status',
          }),
        ],
      }),
      undefined,
    );
  });

  it('retains task progress messages when the final assistant reply is posted', async () => {
    const renderer = createRendererStub();
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      taskCardBlocksEnabled: true,
      threadTs: 'ts1',
    });

    await sink.onEvent({
      type: 'task-update',
      taskId: 'cmd-1',
      title: 'git status',
      status: 'in_progress',
      details: 'Checking repository state',
    });
    await sink.onEvent({
      type: 'assistant-message',
      text: 'REAL_TASK_PLAN_BLOCK_OK summary: commands completed',
    });
    await sink.onEvent({ type: 'lifecycle', phase: 'completed' });

    await sink.finalize();

    expect(renderer.postThreadReply).toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      'REAL_TASK_PLAN_BLOCK_OK summary: commands completed',
      expect.any(Object),
    );
    expect(renderer.deleteThreadProgressMessage).not.toHaveBeenCalled();
    expect(renderer.finalizeThreadProgressMessage).not.toHaveBeenCalled();
    expect(renderer.finalizeThreadProgressMessageStopped).not.toHaveBeenCalled();
  });

  it('clears task progress messages after the final reply when task cards are disabled', async () => {
    const renderer = createRendererStub();
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      taskCardBlocksEnabled: false,
      threadTs: 'ts1',
    });

    await sink.onEvent({
      type: 'task-update',
      taskId: 'cmd-1',
      title: 'git status',
      status: 'in_progress',
      details: 'Checking repository state',
    });
    await sink.onEvent({
      type: 'assistant-message',
      text: 'summary: commands completed',
    });
    await sink.onEvent({ type: 'lifecycle', phase: 'completed' });

    await sink.finalize();

    expect(renderer.deleteThreadProgressMessage).toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      'progress-ts',
    );
  });

  it('does not block execution when progress message updates fail', async () => {
    const renderer = createRendererStub();
    vi.mocked(renderer.upsertThreadProgressMessage).mockRejectedValue(new Error('slack hung'));

    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    await expect(
      sink.onEvent({
        type: 'activity-state',
        state: {
          threadTs: 'ts1',
          status: 'Reading files...',
          activities: ['Reading src/index.ts...'],
          clear: false,
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('counts repeated tool calls when activity reappears after disappearing', async () => {
    const renderer = createRendererStub();
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    // First tool call: Reading file.txt
    await sink.onEvent({
      type: 'activity-state',
      state: {
        threadTs: 'ts1',
        activities: ['Reading file.txt...'],
        clear: false,
      },
    });
    expect(sink.toolHistory.get('Reading')).toBe(1);

    // Transition to different activity (first read completes)
    await sink.onEvent({
      type: 'activity-state',
      state: {
        threadTs: 'ts1',
        activities: ['Editing file.txt...'],
        clear: false,
      },
    });
    expect(sink.toolHistory.get('Editing')).toBe(1);

    // Second tool call: Reading file.txt again (same activity string reappears)
    await sink.onEvent({
      type: 'activity-state',
      state: {
        threadTs: 'ts1',
        activities: ['Editing file.txt...', 'Reading file.txt...'],
        clear: false,
      },
    });
    // Should count the reappearing Reading activity
    expect(sink.toolHistory.get('Reading')).toBe(2);
    expect(sink.toolHistory.get('Editing')).toBe(1);
  });

  it('buffers generated-images and flushes via postGeneratedImages after assistant text reply', async () => {
    const renderer = createRendererStub();
    const postGeneratedImages = vi.mocked(renderer.postGeneratedImages);
    const postThreadReply = vi.mocked(renderer.postThreadReply);
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    const files = [
      { fileName: 'a.png', path: '/tmp/a.png', providerFileId: 'p1' },
      { fileName: 'b.png', path: '/tmp/b.png', providerFileId: 'p2' },
    ];
    await sink.onEvent({ type: 'generated-images', files });
    await sink.onEvent({ type: 'assistant-message', text: 'Here you go.' });

    expect(postThreadReply.mock.invocationCallOrder[0]).toBeLessThan(
      postGeneratedImages.mock.invocationCallOrder[0]!,
    );
    expect(postThreadReply).toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      'Here you go.',
      expect.any(Object),
    );
    expect(postGeneratedImages).toHaveBeenCalledWith(expect.anything(), 'C123', 'ts1', files);
  });

  it('posts assistant text when postGeneratedImages reports failures without dropping the reply', async () => {
    const renderer = createRendererStub();
    const failedFile = { fileName: 'a.png', path: '/x/a.png', providerFileId: 'p1' };
    vi.mocked(renderer.postGeneratedImages).mockResolvedValue([failedFile]);
    const postThreadReply = vi.mocked(renderer.postThreadReply);
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    await sink.onEvent({
      type: 'generated-images',
      files: [failedFile],
    });
    await sink.onEvent({ type: 'assistant-message', text: 'Reply text.' });

    expect(postThreadReply).toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      'Reply text.',
      expect.any(Object),
    );
    expect(renderer.postGeneratedImages).toHaveBeenCalled();
  });

  it('buffers generated-files and flushes them after the assistant text reply', async () => {
    const renderer = createRendererStub();
    const postGeneratedFiles = vi.mocked(renderer.postGeneratedFiles);
    const postThreadReply = vi.mocked(renderer.postThreadReply);
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    const files = [{ fileName: 'report.txt', path: '/tmp/report.txt', providerFileId: 'pf1' }];
    await sink.onEvent({ type: 'generated-files', files });
    await sink.onEvent({ type: 'assistant-message', text: 'Attached.' });

    expect(postThreadReply.mock.invocationCallOrder[0]).toBeLessThan(
      postGeneratedFiles.mock.invocationCallOrder[0]!,
    );
    expect(postGeneratedFiles).toHaveBeenCalledWith(expect.anything(), 'C123', 'ts1', files);
  });

  it('retries generated-files on finalize after assistant-time flush leaves failures', async () => {
    const renderer = createRendererStub();
    const postGeneratedFiles = vi.mocked(renderer.postGeneratedFiles);
    const files = [{ fileName: 'report.txt', path: '/tmp/report.txt', providerFileId: 'pf1' }];
    postGeneratedFiles.mockResolvedValueOnce(files).mockResolvedValueOnce([]);

    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    await sink.onEvent({ type: 'generated-files', files });
    await sink.onEvent({ type: 'assistant-message', text: 'Attached.' });
    await sink.onEvent({ type: 'lifecycle', phase: 'completed' });
    await sink.finalize();

    expect(postGeneratedFiles).toHaveBeenCalledTimes(2);
    expect(postGeneratedFiles).toHaveBeenNthCalledWith(1, expect.anything(), 'C123', 'ts1', files);
    expect(postGeneratedFiles).toHaveBeenNthCalledWith(2, expect.anything(), 'C123', 'ts1', files);
  });

  it('retries postGeneratedImages on finalize after assistant-time flush leaves failures, when lifecycle completed', async () => {
    const renderer = createRendererStub();
    const postGeneratedImages = vi.mocked(renderer.postGeneratedImages);
    const files = [{ fileName: 'a.png', path: '/tmp/a.png', providerFileId: 'p1' }];
    postGeneratedImages.mockResolvedValueOnce(files).mockResolvedValueOnce([]);

    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    await sink.onEvent({ type: 'generated-images', files });
    await sink.onEvent({ type: 'assistant-message', text: 'Here is the answer.' });
    await sink.onEvent({ type: 'lifecycle', phase: 'completed' });
    await sink.finalize();

    expect(postGeneratedImages).toHaveBeenCalledTimes(2);
    expect(postGeneratedImages).toHaveBeenNthCalledWith(1, expect.anything(), 'C123', 'ts1', files);
    expect(postGeneratedImages).toHaveBeenNthCalledWith(2, expect.anything(), 'C123', 'ts1', files);
  });

  it('retries only failed images on finalize after partial assistant-time failure', async () => {
    const renderer = createRendererStub();
    const postGeneratedImages = vi.mocked(renderer.postGeneratedImages);
    const a = { fileName: 'a.png', path: '/tmp/a.png', providerFileId: 'p1' };
    const b = { fileName: 'b.png', path: '/tmp/b.png', providerFileId: 'p2' };
    postGeneratedImages.mockResolvedValueOnce([b]).mockResolvedValueOnce([]);

    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    await sink.onEvent({ type: 'generated-images', files: [a, b] });
    await sink.onEvent({ type: 'assistant-message', text: 'Done.' });
    await sink.onEvent({ type: 'lifecycle', phase: 'completed' });
    await sink.finalize();

    expect(postGeneratedImages).toHaveBeenNthCalledWith(1, expect.anything(), 'C123', 'ts1', [
      a,
      b,
    ]);
    expect(postGeneratedImages).toHaveBeenNthCalledWith(2, expect.anything(), 'C123', 'ts1', [b]);
  });

  it('flushes buffered images on finalize when lifecycle completed', async () => {
    const renderer = createRendererStub();
    const postGeneratedImages = vi.mocked(renderer.postGeneratedImages);
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    const files = [{ fileName: 'a.png', path: '/tmp/a.png', providerFileId: 'p1' }];
    await sink.onEvent({ type: 'generated-images', files });
    await sink.onEvent({ type: 'lifecycle', phase: 'completed' });
    await sink.finalize();

    expect(postGeneratedImages).toHaveBeenCalledWith(expect.anything(), 'C123', 'ts1', files);
  });

  it('preserves buffer when finalize-time postGeneratedImages returns failures; second finalize retries', async () => {
    const renderer = createRendererStub();
    const postGeneratedImages = vi.mocked(renderer.postGeneratedImages);
    const files = [{ fileName: 'a.png', path: '/tmp/a.png', providerFileId: 'p1' }];
    postGeneratedImages.mockResolvedValueOnce(files).mockResolvedValueOnce([]);

    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    await sink.onEvent({ type: 'generated-images', files });
    await sink.onEvent({ type: 'lifecycle', phase: 'completed' });
    await sink.finalize();
    await sink.finalize();

    expect(postGeneratedImages).toHaveBeenCalledTimes(2);
    expect(postGeneratedImages).toHaveBeenNthCalledWith(1, expect.anything(), 'C123', 'ts1', files);
    expect(postGeneratedImages).toHaveBeenNthCalledWith(2, expect.anything(), 'C123', 'ts1', files);
  });

  it('does not flush images on finalize after lifecycle failed', async () => {
    const renderer = createRendererStub();
    const postGeneratedImages = vi.mocked(renderer.postGeneratedImages);
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    await sink.onEvent({
      type: 'generated-images',
      files: [{ fileName: 'a.png', path: '/tmp/a.png', providerFileId: 'p1' }],
    });
    await sink.onEvent({ type: 'lifecycle', phase: 'failed', error: 'boom' });
    await sink.finalize();

    expect(postGeneratedImages).not.toHaveBeenCalled();
  });

  it('lifecycle stopped with no progress posts _Stopped by user._ and not the generic error', async () => {
    const renderer = createRendererStub();
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    await sink.onEvent({ type: 'lifecycle', phase: 'stopped', reason: 'user_stop' });

    expect(renderer.postThreadReply).toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      '_Stopped by user._',
    );
    expect(renderer.postThreadReply).not.toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      expect.stringContaining('Agent execution failed'),
    );
  });

  it('finalize uses stopped progress finalizer when stopped with progress and no assistant reply yet', async () => {
    const renderer = createRendererStub();
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    const state: AgentActivityState = {
      threadTs: 'ts1',
      status: 'Reading files...',
      activities: ['Reading src/index.ts...'],
      clear: false,
    };
    await sink.onEvent({ type: 'activity-state', state });
    await sink.onEvent({ type: 'lifecycle', phase: 'stopped', reason: 'user_stop' });

    expect(renderer.postThreadReply).not.toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      '_Stopped by user._',
    );

    await sink.finalize();

    expect(renderer.finalizeThreadProgressMessageStopped).toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      'progress-ts',
      sink.toolHistory,
    );
    expect(renderer.finalizeThreadProgressMessage).not.toHaveBeenCalled();
    expect(renderer.postThreadReply).not.toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      '_Stopped by user._',
    );
  });

  it('deletes superseded progress instead of showing stopped-by-user UI', async () => {
    const renderer = createRendererStub();
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    await sink.onEvent({
      type: 'activity-state',
      state: {
        threadTs: 'ts1',
        status: 'Reading files...',
        activities: ['Reading src/index.ts...'],
        clear: false,
      },
    });
    await sink.onEvent({ type: 'lifecycle', phase: 'stopped', reason: 'superseded' });
    await sink.finalize();

    expect(renderer.deleteThreadProgressMessage).toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      'progress-ts',
    );
    expect(renderer.finalizeThreadProgressMessageStopped).not.toHaveBeenCalled();
    expect(renderer.postThreadReply).not.toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      '_Stopped by user._',
    );
  });

  it('only includes workspaceLabel on the first message of a turn', async () => {
    const renderer = createRendererStub();
    const postThreadReply = vi.mocked(renderer.postThreadReply);
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
      workspaceBranch: 'feature/my-work',
      workspaceLabel: 'my-workspace',
    });

    // Accumulate some tool activity
    await sink.onEvent({
      type: 'activity-state',
      state: {
        threadTs: 'ts1',
        status: 'Reading files...',
        activities: ['Reading src/index.ts...'],
        clear: false,
      },
    });

    // First message should include workspace label only
    await sink.onEvent({ type: 'assistant-message', text: 'First message' });
    expect(postThreadReply).toHaveBeenLastCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      'First message',
      { workspaceBranch: 'feature/my-work', workspaceLabel: 'my-workspace' },
    );

    // Simulate more tool activity between messages
    await sink.onEvent({
      type: 'activity-state',
      state: {
        threadTs: 'ts1',
        status: 'Searching codebase...',
        activities: ['Searching for patterns...'],
        clear: false,
      },
    });

    // Second message should NOT include toolbar (empty options object)
    await sink.onEvent({ type: 'assistant-message', text: 'Second message' });
    expect(postThreadReply).toHaveBeenLastCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      'Second message',
      {},
    );

    // Third message should also NOT include toolbar
    await sink.onEvent({ type: 'assistant-message', text: 'Third message' });
    expect(postThreadReply).toHaveBeenLastCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      'Third message',
      {},
    );
  });

  it('updates the first assistant reply when workspace branch metadata changes mid-run', async () => {
    const metadataSpy = vi
      .spyOn(workspaceResolverModule, 'resolveWorkspaceDisplayMetadata')
      .mockReturnValueOnce({
        workspaceBranch: 'feature/my-work',
        workspacePullRequestNumber: 123,
        workspacePullRequestUrl: 'https://github.com/Innei/kagura/pull/123',
      })
      .mockReturnValueOnce({
        workspaceBranch: 'feature/renamed-work',
        workspacePullRequestNumber: 456,
        workspacePullRequestUrl: 'https://github.com/Innei/kagura/pull/456',
      });

    const renderer = createRendererStub();
    const postThreadReply = vi.mocked(renderer.postThreadReply).mockResolvedValue({
      blocks: [
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: '_Working in my-workspace (branch: feature/my-work)_' },
          ],
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: 'First message' },
        },
      ] as never,
      text: 'First message',
      ts: 'reply-ts',
    });
    const updateThreadReplyWorkspaceContext = vi
      .mocked(renderer.updateThreadReplyWorkspaceContext)
      .mockResolvedValue({
        blocks: [
          {
            type: 'context',
            elements: [
              { type: 'mrkdwn', text: '_Working in my-workspace (branch: feature/renamed-work)_' },
            ],
          },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: 'First message' },
          },
        ] as never,
        text: 'First message',
        ts: 'reply-ts',
      });

    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
      workspaceBranch: 'feature/my-work',
      workspaceLabel: 'my-workspace',
      workspacePath: '/tmp/my-workspace',
      workspacePullRequestNumber: 123,
      workspacePullRequestUrl: 'https://github.com/Innei/kagura/pull/123',
    });

    await sink.onEvent({ type: 'assistant-message', text: 'First message' });
    await sink.onEvent({
      type: 'activity-state',
      state: {
        threadTs: 'ts1',
        status: 'Reading files...',
        activities: ['Reading src/index.ts...'],
        clear: false,
      },
    });

    expect(postThreadReply).toHaveBeenCalled();
    expect(updateThreadReplyWorkspaceContext).toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      expect.objectContaining({ ts: 'reply-ts' }),
      {
        workspaceBranch: 'feature/renamed-work',
        workspaceLabel: 'my-workspace',
      },
    );

    metadataSpy.mockRestore();
  });

  it('switches the Slack workspace context when provider reports a worktree path', async () => {
    const metadataSpy = vi
      .spyOn(workspaceResolverModule, 'resolveWorkspaceDisplayMetadata')
      .mockReturnValue({
        workspaceBranch: 'feature/worktree',
        workspacePullRequestNumber: 789,
        workspacePullRequestUrl: 'https://github.com/Innei/kagura/pull/789',
      });

    const renderer = createRendererStub();
    vi.mocked(renderer.postThreadReply).mockResolvedValue({
      blocks: [
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: '_Working in repo (branch: main)_' }],
        },
      ] as never,
      text: 'First message',
      ts: 'reply-ts',
    });
    const sessionStore = createMockSessionStore();
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore,
      threadTs: 'ts1',
      workspaceBranch: 'main',
      workspaceLabel: 'repo',
      workspacePath: '/repo/source',
    });

    await sink.onEvent({ type: 'assistant-message', text: 'First message' });
    await sink.onEvent({
      type: 'workspace-context',
      workspaceLabel: 'repo-worktree',
      workspacePath: '/repo/worktree',
      workspaceRepoId: 'repo-id',
    });

    expect(sessionStore.patch).toHaveBeenCalledWith('ts1', {
      workspaceLabel: 'repo-worktree',
      workspacePath: '/repo/worktree',
      workspaceRepoId: 'repo-id',
    });
    expect(renderer.updateThreadReplyWorkspaceContext).toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      expect.objectContaining({ ts: 'reply-ts' }),
      {
        workspaceBranch: 'feature/worktree',
        workspaceLabel: 'repo-worktree',
      },
    );

    metadataSpy.mockRestore();
  });

  it('forwards permission requests to the Slack permission bridge', async () => {
    const client = createMockClient();
    const permissionBridge = {
      requestPermission: vi.fn().mockResolvedValue({ allowed: true }),
    } as unknown as SlackPermissionBridge;
    const sink = createActivitySink({
      channel: 'C123',
      client,
      logger: createTestLogger(),
      permissionBridge,
      renderer: createRendererStub(),
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
      userId: 'U123',
    });

    await expect(
      sink.requestPermission?.(
        {
          description: 'Needs shell access',
          input: { command: 'echo ok' },
          toolName: 'Bash',
        },
        { signal: undefined },
      ),
    ).resolves.toEqual({ allowed: true });

    expect(permissionBridge.requestPermission).toHaveBeenCalledWith(client, {
      channelId: 'C123',
      description: 'Needs shell access',
      expectedUserId: 'U123',
      input: { command: 'echo ok' },
      signal: undefined,
      threadTs: 'ts1',
      toolName: 'Bash',
    });
  });

  it('persists analytics on finalize when lifecycle completed and usage info available', async () => {
    const analyticsStore = createMockAnalyticsStore();
    const sink = createActivitySink({
      analyticsStore,
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer: createRendererStub(),
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
      userId: 'U999',
    });

    const usage = {
      totalCostUSD: 0.01,
      durationMs: 5000,
      modelUsage: [
        {
          model: 'claude-sonnet-4',
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadInputTokens: 2000,
          cacheCreationInputTokens: 100,
          cacheHitRate: 66.7,
          costUSD: 0.01,
        },
      ],
    };

    await sink.onEvent({ type: 'usage-info', usage });
    await sink.onEvent({ type: 'lifecycle', phase: 'completed' });
    await sink.finalize();

    expect(analyticsStore.upsert).toHaveBeenCalledWith('ts1', 'U999', usage);
  });

  it('appends usage info to the last assistant reply instead of posting a detached message', async () => {
    const renderer = createRendererStub();
    vi.mocked(renderer.postThreadReply).mockResolvedValue({
      blocks: [],
      text: 'Done',
      ts: 'reply-ts',
    });
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
      userId: 'U999',
    });

    const usage = {
      totalCostUSD: 0.01,
      durationMs: 5000,
      modelUsage: [
        {
          model: 'claude-sonnet-4',
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadInputTokens: 2000,
          cacheCreationInputTokens: 100,
          cacheHitRate: 66.7,
          costUSD: 0.01,
        },
      ],
    };

    await sink.onEvent({ type: 'assistant-message', text: 'Done' });
    await sink.onEvent({ type: 'usage-info', usage });
    await sink.onEvent({ type: 'lifecycle', phase: 'completed' });
    await sink.finalize();

    expect(renderer.appendSessionUsageInfoToThreadReply).toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      {
        blocks: [],
        text: 'Done',
        ts: 'reply-ts',
      },
      usage,
      {},
    );
    expect(renderer.postSessionUsageInfo).not.toHaveBeenCalled();
  });

  it('uses PR metadata from a provider-reported worktree in the usage bar', async () => {
    const metadataSpy = vi
      .spyOn(workspaceResolverModule, 'resolveWorkspaceDisplayMetadata')
      .mockReturnValue({
        workspaceBranch: 'feature/worktree',
        workspacePullRequestNumber: 789,
        workspacePullRequestUrl: 'https://github.com/Innei/kagura/pull/789',
      });
    const renderer = createRendererStub();
    vi.mocked(renderer.postThreadReply).mockResolvedValue({
      blocks: [],
      text: 'Done',
      ts: 'reply-ts',
    });
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
      userId: 'U999',
      workspaceBranch: 'main',
      workspaceLabel: 'repo',
      workspacePath: '/repo/source',
    });
    const usage = {
      totalCostUSD: 0.01,
      durationMs: 5000,
      modelUsage: [
        {
          model: 'claude-sonnet-4',
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadInputTokens: 2000,
          cacheCreationInputTokens: 100,
          cacheHitRate: 66.7,
          costUSD: 0.01,
        },
      ],
    };

    await sink.onEvent({ type: 'assistant-message', text: 'Done' });
    await sink.onEvent({
      type: 'workspace-context',
      workspaceLabel: 'repo-worktree',
      workspacePath: '/repo/worktree',
    });
    await sink.onEvent({ type: 'usage-info', usage });
    await sink.onEvent({ type: 'lifecycle', phase: 'completed' });
    await sink.finalize();

    expect(renderer.appendSessionUsageInfoToThreadReply).toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      expect.objectContaining({ ts: 'reply-ts' }),
      usage,
      {
        workspacePullRequestNumber: 789,
        workspacePullRequestUrl: 'https://github.com/Innei/kagura/pull/789',
      },
    );

    metadataSpy.mockRestore();
  });

  it('does not persist analytics when no analyticsStore provided', async () => {
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer: createRendererStub(),
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
      userId: 'U999',
    });

    const usage = {
      totalCostUSD: 0.01,
      durationMs: 5000,
      modelUsage: [
        {
          model: 'claude-sonnet-4',
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadInputTokens: 2000,
          cacheCreationInputTokens: 100,
          cacheHitRate: 66.7,
          costUSD: 0.01,
        },
      ],
    };

    await sink.onEvent({ type: 'usage-info', usage });
    await sink.onEvent({ type: 'lifecycle', phase: 'completed' });
    await sink.finalize();
  });

  it('does not persist analytics when no usage info available', async () => {
    const analyticsStore = createMockAnalyticsStore();
    const sink = createActivitySink({
      analyticsStore,
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer: createRendererStub(),
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
      userId: 'U999',
    });

    await sink.onEvent({ type: 'lifecycle', phase: 'completed' });
    await sink.finalize();

    expect(analyticsStore.upsert).not.toHaveBeenCalled();
  });
});
