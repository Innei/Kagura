import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GeneratedImageFile, GeneratedOutputFile, SessionUsageInfo } from '~/agent/types.js';
import type { AppLogger } from '~/logger/index.js';
import { SlackRenderer, SlackRenderTimeoutError } from '~/slack/render/slack-renderer.js';
import type { SlackBlock, SlackWebClientLike } from '~/slack/types.js';

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

function createClientFixture(): {
  client: SlackWebClientLike;
  imagePostCalls: Array<Parameters<SlackWebClientLike['chat']['postMessage']>[0]>;
} {
  const imagePostCalls: Array<Parameters<SlackWebClientLike['chat']['postMessage']>[0]> = [];

  const client: SlackWebClientLike = {
    assistant: { threads: { setStatus: vi.fn().mockResolvedValue({}) } },
    chat: {
      delete: vi.fn().mockResolvedValue({}),
      postMessage: vi.fn().mockImplementation(async (args) => {
        imagePostCalls.push(args);
        return { ts: 'post-ts' };
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    conversations: { replies: vi.fn().mockResolvedValue({ messages: [] }) },
    files: {
      uploadV2: vi.fn(),
    },
    reactions: {
      add: vi.fn().mockResolvedValue({}),
      remove: vi.fn().mockResolvedValue({}),
    },
    views: {
      open: vi.fn().mockResolvedValue({}),
      publish: vi.fn().mockResolvedValue({}),
    },
  };

  return { client, imagePostCalls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SlackRenderer.postGeneratedImages', () => {
  it('uploads each image file to the thread', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'slack-renderer-'));
    const pathA = path.join(dir, 'a.png');
    const pathB = path.join(dir, 'b.png');
    await writeFile(pathA, Buffer.from('png-a'));
    await writeFile(pathB, Buffer.from('png-b'));

    const { client, imagePostCalls } = createClientFixture();
    const uploadCalls: Array<Parameters<SlackWebClientLike['files']['uploadV2']>[0]> = [];
    let uploadId = 0;
    vi.mocked(client.files.uploadV2).mockImplementation(async (args) => {
      uploadCalls.push(args);
      uploadId += 1;
      return { files: [{ id: `F_ID_${uploadId}` }] };
    });

    const renderer = new SlackRenderer(createTestLogger());
    const files: GeneratedImageFile[] = [
      { fileName: 'a.png', path: pathA, providerFileId: 'pf1' },
      { fileName: 'b.png', path: pathB, providerFileId: 'pf2' },
    ];

    const failed = await renderer.postGeneratedImages(client, 'C1', 'ts-root', files);

    expect(failed).toEqual([]);
    expect(uploadCalls).toHaveLength(2);
    expect(uploadCalls[0]).toMatchObject({
      channel_id: 'C1',
      thread_ts: 'ts-root',
      filename: 'a.png',
      title: 'a.png',
      alt_text: 'a.png',
    });
    expect(uploadCalls[0]!.file.equals(Buffer.from('png-a'))).toBe(true);
    expect(uploadCalls[1]).toMatchObject({
      channel_id: 'C1',
      thread_ts: 'ts-root',
      filename: 'b.png',
    });
    expect(uploadCalls[1]!.file.equals(Buffer.from('png-b'))).toBe(true);

    expect(imagePostCalls).toHaveLength(0);
  });

  it('warns and skips the image block when upload returns no file id', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'slack-renderer-warn-'));
    const pathA = path.join(dir, 'x.png');
    await writeFile(pathA, Buffer.from('x'));

    const logger = createTestLogger();
    const { client, imagePostCalls } = createClientFixture();
    vi.mocked(client.files.uploadV2).mockResolvedValue({ files: [{}] });

    const renderer = new SlackRenderer(logger);
    const meta = { fileName: 'x.png', path: pathA, providerFileId: 'pf' };
    const failed = await renderer.postGeneratedImages(client, 'C1', 'ts-root', [meta]);

    expect(failed).toEqual([meta]);
    expect(logger.warn).toHaveBeenCalled();
    expect(imagePostCalls).toHaveLength(0);
  });

  it('extracts file ids from Slack uploadV2 completion responses', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'slack-renderer-uploadv2-'));
    const pathA = path.join(dir, 'nested.png');
    await writeFile(pathA, Buffer.from('nested'));

    const { client, imagePostCalls } = createClientFixture();
    vi.mocked(client.files.uploadV2).mockResolvedValue({
      files: [{ files: [{ id: 'F_NESTED' }] }],
    });

    const renderer = new SlackRenderer(createTestLogger());
    const failed = await renderer.postGeneratedImages(client, 'C1', 'ts-root', [
      { fileName: 'nested.png', path: pathA, providerFileId: 'pf-nested' },
    ]);

    expect(failed).toEqual([]);
    expect(imagePostCalls).toHaveLength(0);
  });

  it('returns only the files that failed upload, not successful ones', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'slack-renderer-partial-'));
    const pathA = path.join(dir, 'a.png');
    const pathB = path.join(dir, 'b.png');
    await writeFile(pathA, Buffer.from('a'));
    await writeFile(pathB, Buffer.from('b'));

    const { client, imagePostCalls } = createClientFixture();
    vi.mocked(client.files.uploadV2).mockImplementation(async (args) => {
      if (args.filename === 'b.png') {
        throw new Error('upload failed');
      }
      return { files: [{ id: 'F_OK' }] };
    });

    const renderer = new SlackRenderer(createTestLogger());
    const a: GeneratedImageFile = { fileName: 'a.png', path: pathA, providerFileId: 'pa' };
    const b: GeneratedImageFile = { fileName: 'b.png', path: pathB, providerFileId: 'pb' };
    const failed = await renderer.postGeneratedImages(client, 'C1', 'ts-root', [a, b]);

    expect(failed).toEqual([b]);
    expect(imagePostCalls).toHaveLength(0);
  });
});

describe('SlackRenderer.postSessionUsageInfo', () => {
  it('omits unknown cost and subtracts cached input for Codex-style usage', async () => {
    const { client, imagePostCalls } = createClientFixture();
    const renderer = new SlackRenderer(createTestLogger());
    const usage: SessionUsageInfo = {
      costKnown: false,
      durationMs: 12_345,
      totalCostUSD: 0,
      modelUsage: [
        {
          cacheCreationInputTokens: 0,
          cacheHitRate: 50,
          cacheReadInputTokens: 50_000,
          costUSD: 0,
          inputTokens: 100_000,
          inputTokensIncludeCache: true,
          model: 'gpt-5.5',
          outputTokens: 5_000,
        },
      ],
    };

    await renderer.postSessionUsageInfo(client, 'C1', '1712345678.000100', usage);

    const text = imagePostCalls[0]?.text;
    expect(text).toContain('12.3s');
    expect(text).not.toContain('$0.0000');
    expect(text).toContain('gpt-5.5: 55.0k non-cached in + out (50% cache)');
  });
});

describe('SlackRenderer.appendSessionUsageInfoToThreadReply', () => {
  it('updates the assistant reply with a usage context block', async () => {
    const { client } = createClientFixture();
    const renderer = new SlackRenderer(createTestLogger());
    const usage: SessionUsageInfo = {
      durationMs: 12_345,
      totalCostUSD: 0.1234,
      modelUsage: [
        {
          cacheCreationInputTokens: 0,
          cacheHitRate: 50,
          cacheReadInputTokens: 50_000,
          costUSD: 0.1234,
          inputTokens: 100_000,
          inputTokensIncludeCache: true,
          model: 'gpt-5.5',
          outputTokens: 5_000,
        },
      ],
    };

    const appended = await renderer.appendSessionUsageInfoToThreadReply(
      client,
      'C1',
      '1712345678.000100',
      {
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: 'Done' },
          },
        ],
        text: 'Done',
        ts: 'reply-ts',
      },
      usage,
    );

    expect(appended).toBe(true);
    expect(client.chat.update).toHaveBeenCalledWith({
      channel: 'C1',
      ts: 'reply-ts',
      text: expect.stringContaining('gpt-5.5: 55.0k non-cached in + out (50% cache)'),
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: 'Done' },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: expect.stringContaining('gpt-5.5: 55.0k non-cached in + out (50% cache)'),
            },
          ],
        },
      ],
    });
  });

  it('renders the PR link in the same usage context row when provided', async () => {
    const { client } = createClientFixture();
    const renderer = new SlackRenderer(createTestLogger());
    const usage: SessionUsageInfo = {
      durationMs: 12_345,
      totalCostUSD: 0.1234,
      modelUsage: [
        {
          cacheCreationInputTokens: 0,
          cacheHitRate: 50,
          cacheReadInputTokens: 50_000,
          costUSD: 0.1234,
          inputTokens: 100_000,
          inputTokensIncludeCache: true,
          model: 'gpt-5.5',
          outputTokens: 5_000,
        },
      ],
    };

    await renderer.appendSessionUsageInfoToThreadReply(
      client,
      'C1',
      '1712345678.000100',
      {
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: 'Done' },
          },
        ],
        text: 'Done',
        ts: 'reply-ts',
      },
      usage,
      {
        workspacePullRequestNumber: 123,
        workspacePullRequestUrl: 'https://github.com/Innei/kagura/pull/123',
      },
    );

    expect(client.chat.update).toHaveBeenCalledWith({
      channel: 'C1',
      ts: 'reply-ts',
      text: expect.stringContaining('PR: <https://github.com/Innei/kagura/pull/123|#123>'),
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: 'Done' },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: expect.stringContaining('PR: <https://github.com/Innei/kagura/pull/123|#123>'),
            },
          ],
        },
      ],
    });
  });
});

describe('SlackRenderer.postGeneratedFiles', () => {
  it('uploads non-image files without posting extra image blocks', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'slack-renderer-files-'));
    const filePath = path.join(dir, 'report.txt');
    await writeFile(filePath, Buffer.from('report body'));

    const { client, imagePostCalls } = createClientFixture();
    const uploadCalls: Array<Parameters<SlackWebClientLike['files']['uploadV2']>[0]> = [];
    vi.mocked(client.files.uploadV2).mockImplementation(async (args) => {
      uploadCalls.push(args);
      return { files: [{ id: 'F_FILE' }] };
    });

    const renderer = new SlackRenderer(createTestLogger());
    const files: GeneratedOutputFile[] = [
      { fileName: 'report.txt', path: filePath, providerFileId: 'pf-report' },
    ];

    const failed = await renderer.postGeneratedFiles(client, 'C1', 'ts-root', files);

    expect(failed).toEqual([]);
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0]).toMatchObject({
      channel_id: 'C1',
      thread_ts: 'ts-root',
      filename: 'report.txt',
      title: 'report.txt',
    });
    expect(uploadCalls[0]).not.toHaveProperty('alt_text');
    expect(uploadCalls[0]!.file.equals(Buffer.from('report body'))).toBe(true);
    expect(imagePostCalls).toHaveLength(0);
  });
});

describe('SlackRenderer timeouts', () => {
  it('times out Slack API operations that never settle', async () => {
    vi.useFakeTimers();

    const { client } = createClientFixture();
    vi.mocked(client.chat.update).mockImplementation(
      () => new Promise(() => {}) as ReturnType<SlackWebClientLike['chat']['update']>,
    );

    const renderer = new SlackRenderer(createTestLogger(), undefined, { operationTimeoutMs: 50 });
    const pending = renderer.finalizeThreadProgressMessage(
      client,
      'C1',
      'thread-ts',
      'progress-ts',
    );
    const expectation = expect(pending).rejects.toBeInstanceOf(SlackRenderTimeoutError);

    await vi.advanceTimersByTimeAsync(50);

    await expectation;
  });
});

describe('SlackRenderer.postThreadReply', () => {
  it('prepends only the workspace label context when tool history is omitted', async () => {
    const { client, imagePostCalls } = createClientFixture();
    const renderer = new SlackRenderer(createTestLogger());

    await renderer.postThreadReply(client, 'C1', 'ts-root', 'Hello from Slack.', {
      workspaceLabel: 'repo/worktree',
    });

    expect(imagePostCalls).toHaveLength(1);
    expect(imagePostCalls[0]).toMatchObject({
      channel: 'C1',
      thread_ts: 'ts-root',
      text: 'Hello from Slack.',
    });
    expect(imagePostCalls[0]!.blocks?.[0]).toMatchObject({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '_Working in repo/worktree_' }],
    });
    const contextTexts = (imagePostCalls[0]!.blocks as SlackBlock[] | undefined)
      ?.filter((block) => block.type === 'context')
      .flatMap((block) =>
        (block.elements ?? [])
          .map((element) =>
            'text' in element && typeof element.text === 'string' ? element.text : '',
          )
          .filter(Boolean),
      );
    expect(contextTexts).toEqual(['_Working in repo/worktree_']);
  });

  it('includes the current branch in the workspace context when available', async () => {
    const { client, imagePostCalls } = createClientFixture();
    const renderer = new SlackRenderer(createTestLogger());

    await renderer.postThreadReply(client, 'C1', 'ts-root', 'Hello from Slack.', {
      workspaceBranch: 'feature/slack-branch-pill',
      workspaceLabel: 'repo/worktree',
    });

    const contextTexts = (imagePostCalls[0]!.blocks as SlackBlock[] | undefined)
      ?.filter((block) => block.type === 'context')
      .flatMap((block) =>
        (block.elements ?? [])
          .map((element) =>
            'text' in element && typeof element.text === 'string' ? element.text : '',
          )
          .filter(Boolean),
      );

    expect(contextTexts).toEqual([
      '_Working in repo/worktree (branch: feature/slack-branch-pill)_',
    ]);
  });
});

describe('SlackRenderer.upsertThreadProgressMessage', () => {
  it('renders agent tasks as a Slack plan block', async () => {
    const { client, imagePostCalls } = createClientFixture();
    const renderer = new SlackRenderer(createTestLogger());

    await renderer.upsertThreadProgressMessage(client, 'C1', 'ts-root', {
      clear: false,
      status: 'Running checks...',
      taskCardBlocksEnabled: true,
      tasks: [
        {
          type: 'task-update',
          taskId: 'cmd-1',
          title: 'pnpm test',
          status: 'in_progress',
          details: 'Starting test runner',
        },
        {
          type: 'task-update',
          taskId: 'cmd-2',
          title: 'Read package.json',
          status: 'complete',
          output: 'package metadata loaded',
        },
      ],
      threadTs: 'ts-root',
    });

    expect(imagePostCalls).toHaveLength(1);
    expect(imagePostCalls[0]).toMatchObject({
      channel: 'C1',
      thread_ts: 'ts-root',
      text: 'Running checks... — pnpm test',
    });
    expect(imagePostCalls[0]!.blocks?.[0]).toMatchObject({
      type: 'plan',
      title: 'Running checks...',
      tasks: [
        {
          task_id: 'cmd-1',
          title: 'pnpm test',
          status: 'in_progress',
          details: {
            type: 'rich_text',
            elements: [
              {
                type: 'rich_text_section',
                elements: [{ type: 'text', text: 'Starting test runner' }],
              },
            ],
          },
        },
        {
          task_id: 'cmd-2',
          title: 'Read package.json',
          status: 'complete',
          output: {
            type: 'rich_text',
            elements: [
              {
                type: 'rich_text_section',
                elements: [{ type: 'text', text: 'package metadata loaded' }],
              },
            ],
          },
        },
      ],
    });
  });

  it('renders task progress without Slack task cards when disabled', async () => {
    const { client, imagePostCalls } = createClientFixture();
    const renderer = new SlackRenderer(createTestLogger());

    await renderer.upsertThreadProgressMessage(client, 'C1', 'ts-root', {
      clear: false,
      status: 'Running checks...',
      taskCardBlocksEnabled: false,
      tasks: [
        {
          type: 'task-update',
          taskId: 'cmd-1',
          title: 'pnpm test',
          status: 'in_progress',
          details: 'Starting test runner',
        },
      ],
      loadingMessages: ['Starting test runner'],
      threadTs: 'ts-root',
    });

    expect(imagePostCalls).toHaveLength(1);
    expect(imagePostCalls[0]).toMatchObject({
      channel: 'C1',
      thread_ts: 'ts-root',
      text: 'Running checks... — pnpm test',
    });
    const blocks = imagePostCalls[0]!.blocks as Array<{ type?: string }> | undefined;
    expect(blocks?.some((block) => block.type === 'plan')).toBe(false);
    expect(blocks).toEqual(
      expect.arrayContaining([
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: 'Running checks...' }],
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: 'Starting test runner' }],
        },
      ]),
    );
  });

  it('deduplicates identical task status and detail without Slack task cards', async () => {
    const { client, imagePostCalls } = createClientFixture();
    const renderer = new SlackRenderer(createTestLogger());

    await renderer.upsertThreadProgressMessage(client, 'C1', 'ts-root', {
      clear: false,
      status: 'bun run .agents/skills/sync-submodule/scripts/run.ts',
      taskCardBlocksEnabled: false,
      tasks: [
        {
          type: 'task-update',
          taskId: 'cmd-1',
          title: 'bun run .agents/skills/sync-submodule/scripts/run.ts',
          status: 'in_progress',
        },
      ],
      loadingMessages: ['bun run .agents/skills/sync-submodule/scripts/run.ts'],
      threadTs: 'ts-root',
    });

    expect(imagePostCalls).toHaveLength(1);
    expect(imagePostCalls[0]!.blocks).toEqual([
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'bun run .agents/skills/sync-submodule/scripts/run.ts',
          },
        ],
      },
    ]);
  });

  it('omits the default progress context when task details are present', async () => {
    const { client, imagePostCalls } = createClientFixture();
    const renderer = new SlackRenderer(createTestLogger());

    await renderer.upsertThreadProgressMessage(client, 'C1', 'ts-root', {
      clear: false,
      status: 'Working on your request...',
      taskCardBlocksEnabled: false,
      tasks: [
        {
          type: 'task-update',
          taskId: 'cmd-1',
          title: 'pnpm typecheck',
          status: 'complete',
          details: '[warn] Ignored unknown option',
        },
      ],
      loadingMessages: ['[warn] Ignored unknown option'],
      threadTs: 'ts-root',
    });

    const blocks = imagePostCalls[0]!.blocks as Array<{
      elements?: Array<{ text?: string }>;
      type?: string;
    }>;
    const contextTexts = blocks
      .filter((block) => block.type === 'context')
      .flatMap((block) => block.elements?.map((element) => element.text) ?? []);

    expect(contextTexts).toEqual(['[warn] Ignored unknown option']);
  });
});

describe('SlackRenderer.updateThreadReplyWorkspaceContext', () => {
  it('updates the existing workspace context block when branch metadata changes', async () => {
    const { client } = createClientFixture();
    const renderer = new SlackRenderer(createTestLogger());

    const updated = await renderer.updateThreadReplyWorkspaceContext(
      client,
      'C1',
      'ts-root',
      {
        blocks: [
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: '_Working in repo/worktree (branch: old-branch)_' }],
          },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: 'Hello from Slack.' },
          },
        ],
        text: 'Hello from Slack.',
        ts: 'reply-ts',
      },
      {
        workspaceBranch: 'new-branch',
        workspaceLabel: 'repo/worktree',
      },
    );

    expect(client.chat.update).toHaveBeenCalledWith({
      blocks: [
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: '_Working in repo/worktree (branch: new-branch)_' }],
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: 'Hello from Slack.' },
        },
      ],
      channel: 'C1',
      text: 'Hello from Slack.',
      ts: 'reply-ts',
    });
    expect(updated.blocks?.[0]).toMatchObject({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '_Working in repo/worktree (branch: new-branch)_' }],
    });
  });
});

describe('SlackRenderer.finalizeThreadProgressMessage', () => {
  it('replaces retained progress content with a generic done message', async () => {
    const { client } = createClientFixture();
    const renderer = new SlackRenderer(createTestLogger());

    await renderer.finalizeThreadProgressMessage(
      client,
      'C1',
      'ts-root',
      'progress-ts',
      new Map([
        ['Reading', 3],
        ['Searching', 1],
      ]),
    );

    expect(client.chat.update).toHaveBeenCalledWith({
      channel: 'C1',
      ts: 'progress-ts',
      text: '✅ Done',
      blocks: [
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: '✅ Done' }],
        },
      ],
    });
  });
});
