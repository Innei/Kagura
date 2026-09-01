import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppLogger } from '~/logger/index.js';
import { dispatchThreadConversation } from '~/slack/ingress/conversation-dispatch.js';
import { handleThreadConversation } from '~/slack/ingress/conversation-pipeline.js';
import type { SlackIngressDependencies } from '~/slack/ingress/types.js';
import type { SlackWebClientLike } from '~/slack/types.js';

vi.mock('~/slack/ingress/conversation-pipeline.js', () => ({
  handleThreadConversation: vi.fn().mockResolvedValue(undefined),
}));

const handleThreadConversationMock = vi.mocked(handleThreadConversation);

describe('dispatchThreadConversation', () => {
  beforeEach(() => {
    handleThreadConversationMock.mockClear();
  });

  it('creates a named Slack agent session with the generated short title', async () => {
    const apiCall = vi.fn().mockResolvedValue({});
    const deps = createDeps({
      threadTitleGenerator: {
        generate: vi.fn().mockResolvedValue('接入 Thread Title'),
      },
    });

    await dispatchThreadConversation(createClient(apiCall), deps, createInput());

    expect(apiCall).toHaveBeenCalledTimes(1);
    expect(apiCall).toHaveBeenCalledWith('agents.sessions.setStatus', {
      channel_id: 'C123',
      initiator_user_id: 'U123',
      thread_ts: '1712345678.000100',
      status: 'processing',
      title: '接入 Thread Title',
    });
    expect(handleThreadConversationMock).toHaveBeenCalledOnce();
  });

  it('falls back to cleaned user text when title generation fails', async () => {
    const apiCall = vi.fn().mockResolvedValue({});
    const deps = createDeps({
      threadTitleGenerator: {
        generate: vi.fn().mockRejectedValue(new Error('llm down')),
      },
    });

    await dispatchThreadConversation(
      createClient(apiCall),
      deps,
      createInput({ text: '<@U_BOT> 修复 Slack thread title 命名' }),
    );

    expect(apiCall).toHaveBeenCalledWith('agents.sessions.setStatus', {
      channel_id: 'C123',
      initiator_user_id: 'U123',
      thread_ts: '1712345678.000100',
      status: 'processing',
      title: '修复 Slack thread title 命名',
    });
    expect(deps.logger.warn).toHaveBeenCalledWith(
      'Failed to generate agent session title for thread %s: %s',
      '1712345678.000100',
      'Error: llm down',
    );
    expect(handleThreadConversationMock).toHaveBeenCalledOnce();
  });

  it('does not rename an existing session', async () => {
    const apiCall = vi.fn().mockResolvedValue({});
    const deps = createDeps({ existingSession: true });

    await dispatchThreadConversation(createClient(apiCall), deps, createInput());

    expect(apiCall).not.toHaveBeenCalled();
    expect(handleThreadConversationMock).toHaveBeenCalledOnce();
  });
});

function createInput(overrides: Partial<Parameters<typeof dispatchThreadConversation>[2]> = {}) {
  return {
    addAcknowledgementReaction: true,
    channelId: 'C123',
    logLabel: 'test',
    messageTs: '1712345678.000100',
    rootMessageTs: '1712345678.000100',
    text: '实现 Slack thread title 命名',
    userId: 'U123',
    ...overrides,
  };
}

function createClient(apiCall: SlackWebClientLike['apiCall']): SlackWebClientLike {
  return {
    apiCall,
    chat: {
      delete: vi.fn(),
      postMessage: vi.fn(),
      update: vi.fn(),
    },
    conversations: { replies: vi.fn() },
    files: { uploadV2: vi.fn() },
    reactions: { add: vi.fn(), remove: vi.fn() },
    views: { open: vi.fn(), publish: vi.fn() },
  };
}

function createDeps(
  options: {
    existingSession?: boolean;
    threadTitleGenerator?: SlackIngressDependencies['threadTitleGenerator'];
  } = {},
): SlackIngressDependencies {
  return {
    analyticsStore: {} as SlackIngressDependencies['analyticsStore'],
    channelPreferenceStore: {} as SlackIngressDependencies['channelPreferenceStore'],
    claudeExecutor: {} as SlackIngressDependencies['claudeExecutor'],
    logger: createTestLogger(),
    memoryStore: {} as SlackIngressDependencies['memoryStore'],
    renderer: {} as SlackIngressDependencies['renderer'],
    sessionStore: {
      get: vi.fn(() => (options.existingSession ? { threadTs: '1712345678.000100' } : undefined)),
    } as unknown as SlackIngressDependencies['sessionStore'],
    threadContextLoader: {} as SlackIngressDependencies['threadContextLoader'],
    threadExecutionRegistry: {} as SlackIngressDependencies['threadExecutionRegistry'],
    threadTitleGenerator: options.threadTitleGenerator,
    userInputBridge: {} as SlackIngressDependencies['userInputBridge'],
    workspaceResolver: {} as SlackIngressDependencies['workspaceResolver'],
  };
}

function createTestLogger(): AppLogger {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
    withTag: vi.fn().mockReturnThis(),
  } as unknown as AppLogger;
}
