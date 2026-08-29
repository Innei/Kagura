import { describe, expect, it, vi } from 'vitest';

import { createAgentSessionStoppedHandler } from '~/slack/ingress/agent-session-stopped-handler.js';

function createTestDeps() {
  return {
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      trace: vi.fn(),
      warn: vi.fn(),
      withTag: vi.fn().mockReturnThis(),
    } as any,
    threadExecutionRegistry: {
      claimMessage: vi.fn(() => true),
      listActive: vi.fn(() => []),
      register: vi.fn(() => () => {}),
      stopAll: vi.fn(async () => ({ stopped: 0, failed: 0 })),
      stopByMessage: vi.fn(async () => ({ stopped: 1, failed: 0 })),
      trackMessage: vi.fn(),
    },
  };
}

describe('createAgentSessionStoppedHandler', () => {
  it('stops the thread execution and reactivates the session', async () => {
    const deps = createTestDeps();
    const apiCall = vi.fn().mockResolvedValue({});
    const handler = createAgentSessionStoppedHandler(deps);

    await handler({
      client: { apiCall },
      event: { channel_id: 'C123', thread_ts: '1712345678.000100' },
    });

    expect(deps.threadExecutionRegistry.stopByMessage).toHaveBeenCalledWith(
      '1712345678.000100',
      'user_stop',
    );
    expect(apiCall).toHaveBeenCalledWith('agents.sessions.setStatus', {
      channel_id: 'C123',
      status: 'active',
      thread_ts: '1712345678.000100',
    });
  });

  it('ignores an event without a thread', async () => {
    const deps = createTestDeps();
    const apiCall = vi.fn().mockResolvedValue({});
    const handler = createAgentSessionStoppedHandler(deps);

    await handler({ client: { apiCall }, event: { channel_id: 'C123' } });

    expect(deps.threadExecutionRegistry.stopByMessage).not.toHaveBeenCalled();
    expect(apiCall).not.toHaveBeenCalled();
  });

  it('still reactivates the session when no execution was running', async () => {
    const deps = createTestDeps();
    deps.threadExecutionRegistry.stopByMessage.mockResolvedValue({ stopped: 0, failed: 0 });
    const apiCall = vi.fn().mockResolvedValue({});
    const handler = createAgentSessionStoppedHandler(deps);

    await handler({
      client: { apiCall },
      event: { channel_id: 'C123', thread_ts: '1712345678.000100' },
    });

    expect(apiCall).toHaveBeenCalledOnce();
  });

  it('does not throw when reactivating the session fails', async () => {
    const deps = createTestDeps();
    const apiCall = vi.fn().mockRejectedValue(new Error('slack down'));
    const handler = createAgentSessionStoppedHandler(deps);

    await handler({
      client: { apiCall },
      event: { channel_id: 'C123', thread_ts: '1712345678.000100' },
    });

    expect(deps.logger.warn).toHaveBeenCalled();
  });
});
