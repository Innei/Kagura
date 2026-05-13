import { readFile } from 'node:fs/promises';

import { markdownToBlocks, splitBlocksWithText } from 'markdown-to-slack-blocks';

import type {
  AgentExecutionEvent,
  GeneratedImageFile,
  GeneratedOutputFile,
  SessionUsageInfo,
} from '~/agent/types.js';
import { env } from '~/env/server.js';
import type { AppLogger } from '~/logger/index.js';

import {
  DEFAULT_ASSISTANT_THINKING_STATUS,
  getShuffledThinkingMessages,
  rotateThinkingStatus,
  THINKING_STATUS_MESSAGES,
} from '../thinking-messages.js';
import type {
  SlackBlock,
  SlackFilesUploadV2Response,
  SlackRichTextBlock,
  SlackTaskCardBlock,
  SlackWebClientLike,
} from '../types.js';
import type { SlackStatusProbe } from './status-probe.js';

const THINKING_STATUS_ROTATION_INTERVAL_MS = 2500;

const THINKING_STATUS_SET = new Set<string>(THINKING_STATUS_MESSAGES);

function isThinkingStatus(status: string | undefined): boolean {
  return !status || status === DEFAULT_ASSISTANT_THINKING_STATUS || THINKING_STATUS_SET.has(status);
}

// Slack renders `assistant.threads.setStatus` output as "{AppName} {status}"
// and each `loading_messages` entry the same way — it does NOT auto-prepend
// "is". Wrap each fragment with a leading "is " (and lowercase the first
// letter) so it reads as "cc-001 is turning the question over..." instead of
// "cc-001 Turning the question over...".
function toSlackStatusFragment(text: string): string {
  if (!text) return text;
  if (text.startsWith('is ')) return text;
  const first = text.charCodeAt(0);
  const head = first >= 65 && first <= 90 ? text[0]!.toLowerCase() : text[0]!;
  return `is ${head}${text.slice(1)}`;
}

interface RendererUiState {
  clear: boolean;
  composing?: boolean | undefined;
  loadingMessages?: string[] | undefined;
  status?: string | undefined;
  taskCardBlocksEnabled?: boolean | undefined;
  tasks?: ProgressTask[] | undefined;
  threadTs: string;
  toolHistory?: Map<string, number> | undefined;
}

export type ProgressTask = Extract<AgentExecutionEvent, { type: 'task-update' }>;

export interface PostedThreadReply {
  blocks?: SlackBlock[];
  text: string;
  ts: string;
}

interface ThreadReplyContextOptions {
  toolHistory?: Map<string, number>;
  workspaceBranch?: string;
  workspaceLabel?: string;
  workspacePullRequestNumber?: number;
  workspacePullRequestUrl?: string;
}

const DEFAULT_PROGRESS_STATUS = 'Working on your request...';
const DEFAULT_SLACK_OPERATION_TIMEOUT_MS = 15_000;

export class SlackRenderTimeoutError extends Error {
  constructor(action: string, context: string, timeoutMs: number) {
    super(`Slack render ${action} timed out after ${timeoutMs}ms (${context})`);
    this.name = 'SlackRenderTimeoutError';
  }
}

export class SlackRenderer {
  private readonly operationTimeoutMs: number;
  private readonly activeThinkingRotations = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private readonly logger: AppLogger,
    private readonly statusProbe?: SlackStatusProbe,
    options?: {
      operationTimeoutMs?: number | undefined;
    },
  ) {
    this.operationTimeoutMs = options?.operationTimeoutMs ?? DEFAULT_SLACK_OPERATION_TIMEOUT_MS;
  }

  async addAcknowledgementReaction(
    client: SlackWebClientLike,
    channelId: string,
    messageTs: string,
  ): Promise<void> {
    await client.reactions.add({
      channel: channelId,
      timestamp: messageTs,
      name: env.SLACK_REACTION_NAME,
    });

    this.logger.debug('Added acknowledgement reaction to message %s', messageTs);
  }

  async removeAcknowledgementReaction(
    client: SlackWebClientLike,
    channelId: string,
    messageTs: string,
  ): Promise<void> {
    await client.reactions.remove({
      channel: channelId,
      timestamp: messageTs,
      name: env.SLACK_REACTION_NAME,
    });

    this.logger.debug('Removed acknowledgement reaction from message %s', messageTs);
  }

  async addCompletionReaction(
    client: SlackWebClientLike,
    channelId: string,
    messageTs: string,
  ): Promise<void> {
    await client.reactions.add({
      channel: channelId,
      timestamp: messageTs,
      name: env.SLACK_REACTION_DONE_NAME,
    });

    this.logger.debug('Added completion reaction to message %s', messageTs);
  }

  async showThinkingIndicator(
    client: SlackWebClientLike,
    channelId: string,
    threadTs: string,
    loadingMessages?: readonly string[],
  ): Promise<void> {
    this.stopThinkingRotation(threadTs);

    await this.setUiState(client, channelId, {
      threadTs,
      status: DEFAULT_ASSISTANT_THINKING_STATUS,
      loadingMessages: loadingMessages ? [...loadingMessages] : getShuffledThinkingMessages(),
      clear: false,
    });

    let rotationIndex = 0;
    const timer = setInterval(() => {
      rotationIndex++;
      const status = toSlackStatusFragment(rotateThinkingStatus(rotationIndex));
      client.assistant.threads
        .setStatus({ channel_id: channelId, thread_ts: threadTs, status })
        .catch(() => {});
    }, THINKING_STATUS_ROTATION_INTERVAL_MS);
    this.activeThinkingRotations.set(threadTs, timer);
  }

  private stopThinkingRotation(threadTs: string): void {
    const timer = this.activeThinkingRotations.get(threadTs);
    if (timer) {
      clearInterval(timer);
      this.activeThinkingRotations.delete(threadTs);
    }
  }

  async setUiState(
    client: SlackWebClientLike,
    channelId: string,
    state: RendererUiState,
  ): Promise<void> {
    if (!isThinkingStatus(state.status)) {
      this.stopThinkingRotation(state.threadTs);
    }

    if (state.clear) {
      await this.clearUiState(client, channelId, state.threadTs);
      return;
    }

    const renderedStatus = toSlackStatusFragment(state.status ?? '');
    const renderedLoadingMessages = state.loadingMessages?.map(toSlackStatusFragment);
    await this.withSlackTiming(
      'assistant.threads.setStatus',
      `channel=${channelId} thread=${state.threadTs} clear=false status=${JSON.stringify(renderedStatus)} loadingMessages=${renderedLoadingMessages?.length ?? 0}`,
      async () =>
        client.assistant.threads.setStatus({
          channel_id: channelId,
          thread_ts: state.threadTs,
          status: renderedStatus,
          ...(renderedLoadingMessages ? { loading_messages: renderedLoadingMessages } : {}),
        }),
    );
    await this.statusProbe?.recordStatus({
      channelId,
      clear: false,
      kind: 'status',
      ...(renderedLoadingMessages ? { loadingMessages: [...renderedLoadingMessages] } : {}),
      recordedAt: new Date().toISOString(),
      status: renderedStatus,
      threadTs: state.threadTs,
    });
  }

  async clearUiState(
    client: SlackWebClientLike,
    channelId: string,
    threadTs: string,
  ): Promise<void> {
    this.stopThinkingRotation(threadTs);

    await this.withSlackTiming(
      'assistant.threads.setStatus',
      `channel=${channelId} thread=${threadTs} clear=true`,
      async () =>
        client.assistant.threads.setStatus({
          channel_id: channelId,
          thread_ts: threadTs,
          status: '',
        }),
    );
    await this.statusProbe?.recordStatus({
      channelId,
      clear: true,
      kind: 'status',
      recordedAt: new Date().toISOString(),
      status: '',
      threadTs,
    });
  }

  async upsertThreadProgressMessage(
    client: SlackWebClientLike,
    channelId: string,
    threadTs: string,
    state: RendererUiState,
    progressMessageTs?: string,
  ): Promise<string | undefined> {
    if (state.clear) {
      if (progressMessageTs) {
        await this.deleteThreadProgressMessage(client, channelId, threadTs, progressMessageTs);
      }
      return undefined;
    }

    const text = this.buildProgressMessageText(state);
    const blocks = this.buildProgressMessageBlocks(state);

    if (progressMessageTs) {
      await this.withSlackTiming(
        'chat.update(progress)',
        `channel=${channelId} thread=${threadTs} messageTs=${progressMessageTs} textLength=${text.length}`,
        async () =>
          client.chat.update({
            channel: channelId,
            ts: progressMessageTs,
            text,
            blocks,
          }),
      );
      await this.statusProbe?.recordProgressMessage({
        action: 'update',
        channelId,
        kind: 'progress-message',
        messageTs: progressMessageTs,
        recordedAt: new Date().toISOString(),
        text,
        threadTs,
      });
      return progressMessageTs;
    }

    const response = await this.withSlackTiming(
      'chat.postMessage(progress)',
      `channel=${channelId} thread=${threadTs} textLength=${text.length}`,
      async () =>
        client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text,
          blocks,
        }),
    );

    await this.statusProbe?.recordProgressMessage({
      action: 'post',
      channelId,
      kind: 'progress-message',
      ...(response.ts ? { messageTs: response.ts } : {}),
      recordedAt: new Date().toISOString(),
      text,
      threadTs,
    });

    return response.ts;
  }

  async deleteThreadProgressMessage(
    client: SlackWebClientLike,
    channelId: string,
    threadTs: string,
    progressMessageTs: string,
  ): Promise<void> {
    await this.withSlackTiming(
      'chat.delete(progress)',
      `channel=${channelId} thread=${threadTs} messageTs=${progressMessageTs}`,
      async () =>
        client.chat.delete({
          channel: channelId,
          ts: progressMessageTs,
        }),
    );
    await this.statusProbe?.recordProgressMessage({
      action: 'delete',
      channelId,
      kind: 'progress-message',
      messageTs: progressMessageTs,
      recordedAt: new Date().toISOString(),
      threadTs,
    });
  }

  async finalizeThreadProgressMessage(
    client: SlackWebClientLike,
    channelId: string,
    threadTs: string,
    progressMessageTs: string,
    _toolHistory?: Map<string, number>,
  ): Promise<void> {
    const text = '\u2705 Done';
    const blocks: SlackBlock[] = [
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text }],
      },
    ];

    await this.withSlackTiming(
      'chat.update(progress-finalize)',
      `channel=${channelId} thread=${threadTs} messageTs=${progressMessageTs} textLength=${text.length}`,
      async () =>
        client.chat.update({
          channel: channelId,
          ts: progressMessageTs,
          text,
          blocks,
        }),
    );
    await this.statusProbe?.recordProgressMessage({
      action: 'finalize',
      channelId,
      kind: 'progress-message',
      messageTs: progressMessageTs,
      recordedAt: new Date().toISOString(),
      text,
      threadTs,
    });
  }

  async finalizeThreadProgressMessageStopped(
    client: SlackWebClientLike,
    channelId: string,
    threadTs: string,
    progressMessageTs: string,
    _toolHistory?: Map<string, number>,
  ): Promise<void> {
    const text = 'Stopped by user.';
    const blocks: SlackBlock[] = [
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text }],
      },
    ];

    await this.withSlackTiming(
      'chat.update(progress-stopped)',
      `channel=${channelId} thread=${threadTs} messageTs=${progressMessageTs} textLength=${text.length}`,
      async () =>
        client.chat.update({
          channel: channelId,
          ts: progressMessageTs,
          text,
          blocks,
        }),
    );
    await this.statusProbe?.recordProgressMessage({
      action: 'stopped',
      channelId,
      kind: 'progress-message',
      messageTs: progressMessageTs,
      recordedAt: new Date().toISOString(),
      text,
      threadTs,
    });
  }

  async postThreadReply(
    client: SlackWebClientLike,
    channelId: string,
    threadTs: string,
    text: string,
    options?: ThreadReplyContextOptions,
  ): Promise<PostedThreadReply | undefined> {
    if (!text.trim()) {
      return undefined;
    }

    const blocks = markdownToBlocks(normalizeUnderscoreEmphasis(text), {
      preferSectionBlocks: false,
    });
    const batches = splitBlocksWithText(blocks);

    if (batches.length > 0) {
      const prefixBlocks = buildThreadReplyContextBlocks(options);

      if (prefixBlocks.length > 0) {
        const first = batches[0]!;
        first.blocks = [...prefixBlocks, ...(first.blocks ?? [])];
      }
    }

    let lastReply: PostedThreadReply | undefined;
    for (const [index, batch] of batches.entries()) {
      const response = await this.withSlackTiming(
        'chat.postMessage(thread-reply)',
        `channel=${channelId} thread=${threadTs} batch=${index + 1}/${batches.length} textLength=${batch.text.length}`,
        async () =>
          client.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: batch.text,
            blocks: batch.blocks,
          }),
      );
      if (response.ts) {
        lastReply = {
          text: batch.text,
          ts: response.ts,
          ...(batch.blocks ? { blocks: batch.blocks as SlackBlock[] } : {}),
        };
      }
    }

    return lastReply;
  }

  async updateThreadReplyWorkspaceContext(
    client: SlackWebClientLike,
    channelId: string,
    threadTs: string,
    reply: PostedThreadReply,
    options: Omit<ThreadReplyContextOptions, 'toolHistory'>,
  ): Promise<PostedThreadReply> {
    const nextBlocks = replaceWorkspaceContextBlocks(reply.blocks ?? [], options);

    await this.withSlackTiming(
      'chat.update(thread-reply-workspace-context)',
      `channel=${channelId} thread=${threadTs} messageTs=${reply.ts} textLength=${reply.text.length}`,
      async () =>
        client.chat.update({
          channel: channelId,
          ts: reply.ts,
          text: reply.text,
          blocks: nextBlocks,
        }),
    );

    return {
      ...reply,
      blocks: nextBlocks,
    };
  }

  async postGeneratedImages(
    client: SlackWebClientLike,
    channelId: string,
    threadTs: string,
    files: readonly GeneratedImageFile[],
  ): Promise<GeneratedImageFile[]> {
    const failed: GeneratedImageFile[] = [];

    for (const meta of files) {
      const fileId = await this.uploadGeneratedFile(client, channelId, threadTs, meta, 'image');
      if (!fileId) {
        failed.push(meta);
        continue;
      }
    }

    return failed;
  }

  async postGeneratedFiles(
    client: SlackWebClientLike,
    channelId: string,
    threadTs: string,
    files: readonly GeneratedOutputFile[],
  ): Promise<GeneratedOutputFile[]> {
    const failed: GeneratedOutputFile[] = [];

    for (const meta of files) {
      const fileId = await this.uploadGeneratedFile(client, channelId, threadTs, meta, 'file');
      if (!fileId) {
        failed.push(meta);
      }
    }

    return failed;
  }

  async postSessionUsageInfo(
    client: SlackWebClientLike,
    channelId: string,
    threadTs: string,
    usage: SessionUsageInfo,
    options?: {
      workspacePullRequestNumber?: number | undefined;
      workspacePullRequestUrl?: string | undefined;
    },
  ): Promise<void> {
    const usageText = formatSessionUsageInfo(usage, options);
    if (!usageText) return;

    await this.withSlackTiming(
      'chat.postMessage(session-usage)',
      `channel=${channelId} thread=${threadTs} textLength=${usageText.length}`,
      async () =>
        client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: usageText,
          blocks: [
            {
              type: 'context',
              elements: [{ type: 'mrkdwn', text: usageText }],
            },
          ],
        }),
    );
  }

  async postReviewPanelLink(
    client: SlackWebClientLike,
    channelId: string,
    threadTs: string,
    reviewUrl: string,
  ): Promise<void> {
    const text = `Review diff: ${reviewUrl}`;
    await this.withSlackTiming(
      'chat.postMessage(review-panel-link)',
      `channel=${channelId} thread=${threadTs} url=${reviewUrl}`,
      async () =>
        client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '*Review diff is ready.*',
              },
            },
            {
              type: 'actions',
              block_id: 'review_panel_actions',
              elements: [
                {
                  action_id: 'open_review_panel',
                  style: 'primary',
                  text: {
                    emoji: true,
                    text: 'Open Review Panel',
                    type: 'plain_text',
                  },
                  type: 'button',
                  url: reviewUrl,
                },
              ],
            },
          ],
        }),
    );
  }

  async appendSessionUsageInfoToThreadReply(
    client: SlackWebClientLike,
    channelId: string,
    threadTs: string,
    reply: PostedThreadReply,
    usage: SessionUsageInfo,
    options?: {
      workspacePullRequestNumber?: number | undefined;
      workspacePullRequestUrl?: string | undefined;
    },
  ): Promise<boolean> {
    const usageText = formatSessionUsageInfo(usage, options);
    if (!usageText) return true;

    const existingBlocks = reply.blocks ?? [];
    if (
      existingBlocks.some(
        (block) =>
          block.type === 'context' && block.elements.some((element) => element.text === usageText),
      )
    ) {
      return true;
    }
    if (existingBlocks.length >= 50) {
      return false;
    }

    const blocks: SlackBlock[] = [
      ...existingBlocks,
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: usageText }],
      },
    ];
    const text = reply.text.includes(usageText) ? reply.text : `${reply.text}\n\n${usageText}`;

    await this.withSlackTiming(
      'chat.update(session-usage)',
      `channel=${channelId} thread=${threadTs} messageTs=${reply.ts} textLength=${text.length}`,
      async () =>
        client.chat.update({
          channel: channelId,
          ts: reply.ts,
          text,
          blocks,
        }),
    );

    return true;
  }

  private async withSlackTiming<T>(
    action: string,
    context: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    this.logger.info('Slack render %s started (%s)', action, context);
    try {
      const result = await withTimeout(
        operation(),
        this.operationTimeoutMs,
        () => new SlackRenderTimeoutError(action, context, this.operationTimeoutMs),
      );
      this.logger.info(
        'Slack render %s completed in %dms (%s)',
        action,
        Date.now() - startedAt,
        context,
      );
      return result;
    } catch (error) {
      this.logger.warn(
        'Slack render %s failed after %dms (%s): %s',
        action,
        Date.now() - startedAt,
        context,
        String(error),
      );
      throw error;
    }
  }

  private buildProgressMessageText(state: RendererUiState): string {
    if (state.tasks && state.tasks.length > 0) {
      const inFlight = findLastProgressTask(state.tasks, (task) => task.status === 'in_progress');
      const latest = inFlight ?? state.tasks.at(-1);
      const title = latest?.title.trim() || DEFAULT_PROGRESS_STATUS;
      return `${formatPlanTitle(state)} — ${title}`;
    }

    const status = (state.status ?? '').trim() || DEFAULT_PROGRESS_STATUS;
    const detail = this.collectRecentProgressDetails(state.loadingMessages, 1).at(0);

    return detail && detail !== status ? `${status} — ${detail}` : status;
  }

  private buildProgressMessageBlocks(state: RendererUiState): SlackBlock[] {
    if (state.tasks && state.tasks.length > 0 && state.taskCardBlocksEnabled === true) {
      return [
        {
          type: 'plan',
          title: formatPlanTitle(state),
          tasks: state.tasks.map(toSlackTaskCard),
        },
      ];
    }

    const blocks: SlackBlock[] = [];

    const historySummary = formatToolHistorySummary(state.toolHistory);
    if (historySummary) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: historySummary }],
      });
    } else {
      const status = state.status?.trim() || DEFAULT_PROGRESS_STATUS;
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: status }],
      });
    }

    const detail = this.collectRecentProgressDetails(state.loadingMessages, 1).at(0);
    if (detail) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: detail }],
      });
    }

    return blocks;
  }

  private collectRecentProgressDetails(
    loadingMessages: readonly string[] | undefined,
    maxItems: number,
  ): string[] {
    const deduped: string[] = [];
    const seen = new Set<string>();

    for (const rawMessage of [...(loadingMessages ?? [])].reverse()) {
      const message = rawMessage.trim();
      if (!message || seen.has(message)) {
        continue;
      }

      seen.add(message);
      deduped.unshift(message);

      if (deduped.length >= maxItems) {
        break;
      }
    }

    return deduped;
  }

  private async uploadGeneratedFile(
    client: SlackWebClientLike,
    channelId: string,
    threadTs: string,
    meta: GeneratedOutputFile,
    kind: 'file' | 'image',
  ): Promise<string | undefined> {
    let bytes: Buffer;
    try {
      bytes = await readFile(meta.path);
    } catch (error) {
      this.logger.warn('Failed to read generated %s at %s: %s', kind, meta.path, String(error));
      return undefined;
    }

    let response: SlackFilesUploadV2Response;
    try {
      response = await this.withSlackTiming(
        'files.uploadV2',
        `channel=${channelId} thread=${threadTs} kind=${kind} file=${meta.fileName} bytes=${bytes.length}`,
        async () =>
          client.files.uploadV2({
            ...(kind === 'image' ? { alt_text: meta.fileName } : {}),
            channel_id: channelId,
            file: bytes,
            filename: meta.fileName,
            thread_ts: threadTs,
            title: meta.fileName,
          }),
      );
    } catch (error) {
      this.logger.warn('Failed to upload generated %s %s: %s', kind, meta.fileName, String(error));
      return undefined;
    }

    const fileId = extractUploadedFileId(response);
    if (!fileId) {
      this.logger.warn('Upload returned no file id for generated %s %s', kind, meta.fileName);
      return undefined;
    }

    return fileId;
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  createTimeoutError: () => Error,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(createTimeoutError());
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

const FENCED_CODE_BLOCK = /^(`{3}|~{3})[^\n]*\n.+?\n\1/gms;
const INLINE_CODE = /`[^\n`]+`/g;
const UNDERSCORE_EMPHASIS = /\b_([^\n_]+)_\b/g;

export function normalizeUnderscoreEmphasis(markdown: string): string {
  const codeRanges: Array<[number, number]> = [];
  for (const match of markdown.matchAll(FENCED_CODE_BLOCK)) {
    codeRanges.push([match.index, match.index + match[0].length]);
  }
  for (const match of markdown.matchAll(INLINE_CODE)) {
    codeRanges.push([match.index, match.index + match[0].length]);
  }

  return markdown.replaceAll(UNDERSCORE_EMPHASIS, (full, inner, offset) => {
    if (codeRanges.some(([start, end]) => offset >= start && offset < end)) {
      return full;
    }
    return `*${inner}*`;
  });
}

function extractUploadedFileId(response: SlackFilesUploadV2Response): string | undefined {
  const fromFiles = response.files?.find((f) => f.id?.trim())?.id;
  if (fromFiles) {
    return fromFiles;
  }
  const fromNestedFiles = response.files
    ?.flatMap((f) => f.files ?? [])
    .find((f) => f.id?.trim())?.id;
  if (fromNestedFiles) {
    return fromNestedFiles;
  }
  const fromFile = response.file?.id?.trim();
  return fromFile || undefined;
}

function formatDurationSmart(ms: number): string {
  const totalSeconds = ms / 1000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds.toFixed(0)}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds.toFixed(0)}s`;
  }
  return `${seconds.toFixed(1)}s`;
}

function formatPlanTitle(state: RendererUiState): string {
  if (state.composing) {
    return 'Composing response';
  }
  const status = state.status?.trim();
  if (status && status !== DEFAULT_PROGRESS_STATUS) {
    return trimForSlackText(status, 150);
  }
  return 'Working on your request';
}

function toSlackTaskCard(task: ProgressTask): SlackTaskCardBlock {
  const details =
    task.status === 'in_progress' || task.status === 'pending' ? task.details : undefined;
  const output =
    task.output ??
    (task.status === 'complete' || task.status === 'error' ? task.details : undefined);

  return {
    task_id: trimForSlackText(task.taskId, 255),
    title: trimForSlackText(task.title, 150),
    status: task.status,
    ...(details ? { details: toSlackRichTextBlock(task.taskId, 'details', details) } : {}),
    ...(output ? { output: toSlackRichTextBlock(task.taskId, 'output', output) } : {}),
  };
}

function findLastProgressTask(
  tasks: readonly ProgressTask[],
  predicate: (task: ProgressTask) => boolean,
): ProgressTask | undefined {
  for (let index = tasks.length - 1; index >= 0; index--) {
    const task = tasks[index]!;
    if (predicate(task)) {
      return task;
    }
  }
  return undefined;
}

function toSlackRichTextBlock(_taskId: string, _kind: string, text: string): SlackRichTextBlock {
  return {
    type: 'rich_text',
    elements: [
      {
        type: 'rich_text_section',
        elements: [
          {
            type: 'text',
            text: trimForSlackText(text, 1200),
          },
        ],
      },
    ],
  };
}

function trimForSlackText(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatToolHistorySummary(toolHistory?: Map<string, number>): string | undefined {
  if (!toolHistory || toolHistory.size === 0) {
    return undefined;
  }

  const items: string[] = [];
  for (const [verb, count] of toolHistory) {
    items.push(`${verb} x${count}`);
  }

  return items.join('  \u00B7  ');
}

function buildThreadReplyContextBlocks(options?: ThreadReplyContextOptions): Array<{
  type: 'context';
  elements: Array<{ type: 'mrkdwn'; text: string }>;
}> {
  const prefixBlocks: Array<{
    type: 'context';
    elements: Array<{ type: 'mrkdwn'; text: string }>;
  }> = [];

  const workspaceContext = formatWorkspaceContext(
    options?.workspaceLabel,
    options?.workspaceBranch,
  );
  if (workspaceContext) {
    prefixBlocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: workspaceContext }],
    });
  }

  const toolSummary = formatToolHistorySummary(options?.toolHistory);
  if (toolSummary) {
    prefixBlocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: toolSummary }],
    });
  }
  return prefixBlocks;
}

function replaceWorkspaceContextBlocks(
  blocks: SlackBlock[],
  options: Omit<ThreadReplyContextOptions, 'toolHistory'>,
): SlackBlock[] {
  const preservedBlocks = blocks.filter((block) => {
    if (block.type !== 'context') {
      return true;
    }

    const texts = block.elements
      .map((element) => element.text)
      .filter((text): text is string => typeof text === 'string');

    if (texts.some((text) => text.startsWith('_Working in '))) {
      return false;
    }

    return true;
  });

  return [...buildThreadReplyContextBlocks(options), ...preservedBlocks];
}

function formatWorkspaceContext(
  workspaceLabel?: string,
  workspaceBranch?: string,
): string | undefined {
  if (!workspaceLabel) {
    return undefined;
  }

  if (!workspaceBranch) {
    return `_Working in ${workspaceLabel}_`;
  }

  return `_Working in ${workspaceLabel} (branch: ${workspaceBranch})_`;
}

function formatWorkspacePullRequestContext(
  workspacePullRequestUrl?: string,
  workspacePullRequestNumber?: number,
): string | undefined {
  if (!workspacePullRequestUrl) {
    return undefined;
  }

  const label =
    typeof workspacePullRequestNumber === 'number' ? `#${workspacePullRequestNumber}` : 'Open PR';

  return `PR: <${workspacePullRequestUrl}|${label}>`;
}

function formatSessionUsageInfo(
  usage: SessionUsageInfo,
  options?: {
    workspacePullRequestNumber?: number | undefined;
    workspacePullRequestUrl?: string | undefined;
  },
): string | undefined {
  if (!usage.modelUsage || usage.modelUsage.length === 0) {
    return undefined;
  }

  const parts: string[] = [];

  const pullRequestContext = formatWorkspacePullRequestContext(
    options?.workspacePullRequestUrl,
    options?.workspacePullRequestNumber,
  );
  if (pullRequestContext) {
    parts.push(pullRequestContext);
  }

  parts.push(formatDurationSmart(usage.durationMs));

  if (usage.costKnown !== false) {
    parts.push(`$${usage.totalCostUSD.toFixed(4)}`);
  }

  // Format model usage details
  for (const model of usage.modelUsage) {
    const modelName = model.model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
    const nonCachedInputTokens =
      model.inputTokensIncludeCache === true
        ? Math.max(0, model.inputTokens - model.cacheReadInputTokens)
        : model.inputTokens;
    const nonCachedInputAndOutputTokens = nonCachedInputTokens + model.outputTokens;
    const cacheHitPct = model.cacheHitRate.toFixed(0);

    parts.push(
      `${modelName}: ${formatTokenCount(nonCachedInputAndOutputTokens)} non-cached in + out (${cacheHitPct}% cache)`,
    );
  }

  return parts.join('  \u00B7  ');
}

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}k`;
  }
  return String(count);
}
