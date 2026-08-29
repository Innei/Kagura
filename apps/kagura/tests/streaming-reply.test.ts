import { describe, expect, it, vi } from 'vitest';

import type { AppLogger } from '~/logger/index.js';
import { StreamingReply } from '~/slack/render/streaming-reply.js';
import type { SlackWebClientLike } from '~/slack/types.js';

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

function createStreamingClient(overrides?: {
  appendStream?: ReturnType<typeof vi.fn>;
  startStream?: ReturnType<typeof vi.fn>;
  stopStream?: ReturnType<typeof vi.fn>;
}) {
  const startStream = overrides?.startStream ?? vi.fn().mockResolvedValue({ ts: 'S1' });
  const appendStream = overrides?.appendStream ?? vi.fn().mockResolvedValue({});
  const stopStream = overrides?.stopStream ?? vi.fn().mockResolvedValue({});
  const client = {
    chat: { appendStream, startStream, stopStream },
  } as unknown as SlackWebClientLike;
  return { appendStream, client, startStream, stopStream };
}

function createReply(client: SlackWebClientLike, flushChars = 1000) {
  return new StreamingReply(
    client,
    createTestLogger(),
    { channelId: 'C123', recipientTeamId: 'T1', recipientUserId: 'U1', threadTs: '111.1' },
    { flushChars, flushIntervalMs: 0 },
  );
}

describe('StreamingReply', () => {
  it('coalesces deltas into a single start call and stops with blocks', async () => {
    const { client, appendStream, startStream, stopStream } = createStreamingClient();
    const reply = createReply(client);

    reply.append('Hello');
    reply.append(' world');
    const ts = await reply.finish([
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'toolbar' }] },
    ]);

    expect(ts).toBe('S1');
    expect(startStream).toHaveBeenCalledOnce();
    expect(startStream.mock.calls[0]![0]).toMatchObject({
      channel: 'C123',
      markdown_text: 'Hello world',
      recipient_team_id: 'T1',
      recipient_user_id: 'U1',
      thread_ts: '111.1',
    });
    expect(appendStream).not.toHaveBeenCalled();
    expect(stopStream.mock.calls[0]![0]).toMatchObject({ channel: 'C123', ts: 'S1' });
    expect(reply.text).toBe('Hello world');
  });

  it('flushes early once the character threshold is crossed', async () => {
    const { client, appendStream, startStream } = createStreamingClient();
    const reply = createReply(client, 4);

    reply.append('abcd');
    await vi.waitFor(() => expect(startStream).toHaveBeenCalledOnce());
    reply.append('efgh');
    await vi.waitFor(() => expect(appendStream).toHaveBeenCalledOnce());
    await reply.finish();

    expect(appendStream.mock.calls[0]![0]).toMatchObject({ markdown_text: 'efgh', ts: 'S1' });
  });

  it('marks itself failed when startStream throws so the caller can fall back', async () => {
    const { client, stopStream } = createStreamingClient({
      startStream: vi.fn().mockRejectedValue(new Error('nope')),
    });
    const reply = createReply(client, 1);

    reply.append('hello');
    await vi.waitFor(() => expect(reply.failed).toBe(true));
    const ts = await reply.finish();

    expect(ts).toBeUndefined();
    expect(stopStream).not.toHaveBeenCalled();
    expect(reply.text).toBe('hello');
  });

  it('treats a startStream response without a ts as a failure', async () => {
    const { client } = createStreamingClient({ startStream: vi.fn().mockResolvedValue({}) });
    const reply = createReply(client);

    reply.append('hello');
    const ts = await reply.finish();

    expect(ts).toBeUndefined();
    expect(reply.failed).toBe(true);
  });

  it('retains an unappended chunk when appendStream fails mid-stream', async () => {
    const appendStream = vi.fn().mockRejectedValue(new Error('flaky'));
    const { client, stopStream } = createStreamingClient({ appendStream });
    const reply = createReply(client, 3);

    reply.append('abc');
    await vi.waitFor(() => expect(reply.ts).toBe('S1'));
    reply.append('def');
    await vi.waitFor(() => expect(appendStream).toHaveBeenCalled());
    const ts = await reply.finish();

    expect(ts).toBeUndefined();
    expect(stopStream).not.toHaveBeenCalled();
    // 'def' never landed, so the full text stays available for the fallback post.
    expect(reply.text).toBe('abcdef');
  });

  it('does nothing when the client has no streaming methods', async () => {
    const client = { chat: {} } as unknown as SlackWebClientLike;
    const reply = createReply(client);

    reply.append('hello');
    const ts = await reply.finish();

    expect(ts).toBeUndefined();
    expect(reply.failed).toBe(true);
  });

  it('returns undefined without calling Slack when nothing was appended', async () => {
    const { client, startStream, stopStream } = createStreamingClient();
    const reply = createReply(client);

    const ts = await reply.finish();

    expect(ts).toBeUndefined();
    expect(startStream).not.toHaveBeenCalled();
    expect(stopStream).not.toHaveBeenCalled();
  });
});
