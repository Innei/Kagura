import { describe, expect, it, vi } from 'vitest';

import type { AppLogger } from '~/logger/index.js';
import { SlackThreadContextLoader } from '~/slack/context/thread-context-loader.js';
import type { SlackWebClientLike } from '~/slack/types.js';

describe('SlackThreadContextLoader (images)', () => {
  it('uses the configured Slack thread history limit when loading replies', async () => {
    const replies = vi.fn().mockResolvedValue({ messages: [] });
    const client = {
      conversations: { replies },
    } as unknown as SlackWebClientLike;
    const loader = new SlackThreadContextLoader(createTestLogger(), { historyLimit: 25 });

    await loader.loadThread(client, 'C1', '100.000');

    expect(replies).toHaveBeenCalledWith({
      channel: 'C1',
      inclusive: true,
      limit: 25,
      ts: '100.000',
    });
  });

  it('downloads supported thread images into loadedImages with 1-based messageIndex', async () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://files.slack.com/files-pri/T-good/screenshot.png');
      expect(init?.headers).toEqual(
        expect.objectContaining({
          Authorization: 'Bearer xoxb-test',
        }),
      );
      return new Response(pngBytes, {
        status: 200,
        headers: { 'content-type': 'IMAGE/PNG; charset=binary' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createClientFixture({
      messages: [
        {
          ts: '100.000',
          user: 'U1',
          text: 'hello',
          files: [
            {
              id: 'F_GOOD',
              name: 'screenshot.png',
              mimetype: 'image/png; name=slack-metadata',
              url_private: 'https://files.slack.com/files-pri/T-good/screenshot.png',
            },
          ],
        },
      ],
    });

    const loader = new SlackThreadContextLoader(createTestLogger());
    const ctx = await loader.loadThread(client, 'C1', '100.000');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(ctx.loadedImages).toHaveLength(1);
    expect(ctx.messages[0]?.images[0]?.mimeType).toBe('image/png; name=slack-metadata');
    expect(ctx.loadedImages[0]).toMatchObject({
      fileId: 'F_GOOD',
      fileName: 'screenshot.png',
      messageIndex: 1,
      mimeType: 'image/png',
    });
    expect(ctx.loadedImages[0]?.base64Data).toBe(Buffer.from(pngBytes).toString('base64'));
    expect(ctx.loadedFiles).toEqual([]);
    expect(ctx.fileLoadFailures).toEqual([]);
    expect(ctx.imageLoadFailures).toEqual([]);
  });

  it('records per-image failures in imageLoadFailures while still loading the rest', async () => {
    const okBytes = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('bad')) {
        return new Response(null, { status: 404, statusText: 'Not Found' });
      }
      return new Response(okBytes, {
        status: 200,
        headers: { 'content-type': 'image/png; charset=utf-8' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const logger = createTestLogger();
    const warn = vi.spyOn(logger, 'warn');

    const client = createClientFixture({
      messages: [
        {
          ts: '1.0',
          user: 'U1',
          text: 'first',
          files: [
            {
              id: 'F_BAD',
              name: 'missing.png',
              mimetype: 'image/png',
              url_private: 'https://files.slack.com/bad/missing.png',
            },
          ],
        },
        {
          ts: '2.0',
          user: 'U1',
          text: 'second',
          files: [
            {
              id: 'F_OK',
              name: 'ok.png',
              mimetype: 'IMAGE/PNG',
              url_private: 'https://files.slack.com/good/ok.png',
            },
          ],
        },
      ],
    });

    const loader = new SlackThreadContextLoader(logger);
    const ctx = await loader.loadThread(client, 'C1', '1.0');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(ctx.loadedImages).toHaveLength(1);
    expect(ctx.loadedImages[0]?.fileId).toBe('F_OK');
    expect(ctx.loadedImages[0]?.messageIndex).toBe(2);
    expect(ctx.messages[1]?.images[0]?.mimeType).toBe('IMAGE/PNG');
    expect(ctx.loadedImages[0]?.mimeType).toBe('image/png');
    expect(ctx.loadedFiles).toEqual([]);
    expect(ctx.fileLoadFailures).toEqual([]);
    expect(ctx.imageLoadFailures.length).toBeGreaterThanOrEqual(1);
    expect(ctx.imageLoadFailures.some((m) => m.includes('F_BAD') || m.includes('404'))).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it('downloads supported Slack text files into loadedFiles and records truncation metadata', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://files.slack.com/files-pri/T-good/notes.txt');
      return new Response('alpha\nbeta\ngamma', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createClientFixture({
      messages: [
        {
          ts: '3.0',
          user: 'U2',
          text: '',
          files: [
            {
              id: 'F_TEXT',
              name: 'notes.txt',
              mimetype: 'text/plain',
              filetype: 'text',
              url_private: 'https://files.slack.com/files-pri/T-good/notes.txt',
            },
          ],
        },
      ],
    });

    const loader = new SlackThreadContextLoader(createTestLogger());
    const ctx = await loader.loadThread(client, 'C1', '3.0');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(ctx.loadedFiles).toEqual([
      {
        authorId: 'U2',
        content: 'alpha\nbeta\ngamma',
        fileId: 'F_TEXT',
        fileName: 'notes.txt',
        fileType: 'text',
        messageIndex: 1,
        messageTs: '3.0',
        mimeType: 'text/plain',
        slackUrl: 'https://files.slack.com/files-pri/T-good/notes.txt',
        truncated: false,
      },
    ]);
    expect(ctx.fileLoadFailures).toEqual([]);
    expect(ctx.renderedPrompt).toContain('<attached_files>');
    expect(ctx.renderedPrompt).toContain('- notes.txt');
  });

  it('records per-file failures while still loading the rest of the thread', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('bad')) {
        return new Response(new Uint8Array([0, 1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      }

      return new Response('const answer = 42;\n', {
        status: 200,
        headers: { 'content-type': 'application/typescript' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const logger = createTestLogger();
    const warn = vi.spyOn(logger, 'warn');
    const client = createClientFixture({
      messages: [
        {
          ts: '4.0',
          user: 'U4',
          text: 'please review files',
          files: [
            {
              id: 'F_BAD',
              name: 'blob.txt',
              mimetype: 'text/plain',
              url_private: 'https://files.slack.com/bad/blob.txt',
            },
            {
              id: 'F_OK',
              name: 'index.ts',
              mimetype: 'application/typescript',
              url_private: 'https://files.slack.com/good/index.ts',
            },
          ],
        },
      ],
    });

    const loader = new SlackThreadContextLoader(logger);
    const ctx = await loader.loadThread(client, 'C1', '4.0');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(ctx.loadedFiles).toHaveLength(1);
    expect(ctx.loadedFiles[0]?.fileId).toBe('F_OK');
    expect(ctx.loadedFiles[0]?.content).toContain('answer = 42');
    expect(ctx.fileLoadFailures).toHaveLength(1);
    expect(ctx.fileLoadFailures[0]).toContain('F_BAD');
    expect(warn).toHaveBeenCalled();
  });
});

function createClientFixture(options: { messages: unknown[] }): SlackWebClientLike {
  return {
    conversations: {
      replies: vi.fn().mockResolvedValue({ messages: options.messages }),
    },
  } as unknown as SlackWebClientLike;
}

function createTestLogger(): AppLogger {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => createTestLogger(),
  };
  return logger as unknown as AppLogger;
}
