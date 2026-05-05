import { execFileSync } from 'node:child_process';

import type {
  AgentActivityState,
  AgentExecutionEvent,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentUserInputQuestion,
  AgentUserInputRequest,
  AgentUserInputResponse,
  GeneratedImageFile,
  GeneratedOutputFile,
  SessionUsageInfo,
} from '~/agent/types.js';
import type { SessionAnalyticsStore } from '~/analytics/types.js';
import type { AppLogger } from '~/logger/index.js';
import { redact } from '~/logger/redact.js';
import { runtimeError } from '~/logger/runtime.js';
import type { SessionStore } from '~/session/types.js';
import { formatClaudeExecutionFailureReply } from '~/util/error-detail.js';
import { resolveWorkspaceDisplayMetadata } from '~/workspace/resolver.js';

import type { SlackPermissionBridge } from '../interaction/permission-bridge.js';
import type { SlackUserInputBridge } from '../interaction/user-input-bridge.js';
import type { PostedThreadReply, SlackRenderer } from '../render/slack-renderer.js';
import {
  DEFAULT_ASSISTANT_THINKING_STATUS,
  getShuffledThinkingMessages,
  THINKING_LOADING_MESSAGES,
} from '../thinking-messages.js';
import type { SlackWebClientLike } from '../types.js';
import type { QuietAssistantMessageRecorder } from './a2a-output-diagnostics.js';

export interface ActivitySinkOptions {
  analyticsStore?: SessionAnalyticsStore;
  assistantMessageVisibility?: 'public' | 'quiet-final' | undefined;
  channel: string;
  client: SlackWebClientLike;
  executionId?: string | undefined;
  initialGitHead?: string | undefined;
  initialGitStatus?: string | undefined;
  logger: AppLogger;
  logLabel?: string | undefined;
  permissionBridge?: SlackPermissionBridge | undefined;
  quietAssistantMessageRecorder?: QuietAssistantMessageRecorder | undefined;
  quietAssistantPublicMentionIds?: string[] | undefined;
  renderer: SlackRenderer;
  reviewUrl?: string | undefined;
  sessionStore: SessionStore;
  threadTs: string;
  userId?: string;
  userInputBridge?: SlackUserInputBridge;
  workspaceBranch?: string;
  workspaceLabel?: string;
  workspacePath?: string;
  workspacePullRequestNumber?: number;
  workspacePullRequestUrl?: string;
}

export interface ActivitySink {
  readonly finalAssistantText: string | undefined;
  finalize: () => Promise<void>;
  onEvent: (event: AgentExecutionEvent) => Promise<void>;
  requestPermission?: (
    request: AgentPermissionRequest,
    options?: {
      signal?: AbortSignal | undefined;
    },
  ) => Promise<AgentPermissionResponse>;
  requestUserInput?: (
    request: AgentUserInputRequest,
    options?: {
      description?: string | undefined;
      displayName?: string | undefined;
      signal?: AbortSignal | undefined;
      title?: string | undefined;
      toolUseId?: string | undefined;
    },
  ) => Promise<AgentUserInputResponse>;
  readonly terminalPhase: 'completed' | 'failed' | 'stopped' | undefined;
  readonly toolHistory: Map<string, number>;
}

const TOOL_VERB_PATTERN =
  /^(Reading|Searching|Finding|Fetching|Calling|Running|Exploring|Recalling|Saving|Checking|Applying|Editing|Generating|Waiting|Using|Writing) (.+?)(?:\.{3})?$/;

export function createActivitySink(options: ActivitySinkOptions): ActivitySink {
  const {
    analyticsStore,
    assistantMessageVisibility = 'public',
    channel,
    client,
    executionId,
    initialGitHead,
    initialGitStatus,
    logger,
    logLabel,
    permissionBridge,
    quietAssistantMessageRecorder,
    quietAssistantPublicMentionIds = [],
    renderer,
    reviewUrl,
    sessionStore,
    threadTs,
    userId,
    userInputBridge,
    workspaceBranch,
    workspaceLabel: initialWorkspaceLabel,
    workspacePath: initialWorkspacePath,
    workspacePullRequestNumber,
    workspacePullRequestUrl,
  } = options;

  let progressMessageTs: string | undefined;
  let progressMessageActive = false;
  let terminalPhase: 'completed' | 'failed' | 'stopped' | undefined;
  const toolHistory = new Map<string, number>();
  let previousActivities = new Set<string>();
  let lastStateKey: string | undefined;
  let pendingGeneratedFiles: GeneratedOutputFile[] = [];
  let pendingGeneratedImages: GeneratedImageFile[] = [];
  let executionCompletedSuccessfully = false;
  let terminalStopReason:
    | Extract<AgentExecutionEvent, { type: 'lifecycle'; phase: 'stopped' }>['reason']
    | undefined;
  let hasSentToolbarInTurn = false;
  let sessionUsageInfo: SessionUsageInfo | undefined;
  let lastAssistantReply: PostedThreadReply | undefined;
  let lastAssistantText: string | undefined;
  let toolbarReply: PostedThreadReply | undefined;
  const quietAssistantMessages: string[] = [];
  let currentWorkspaceBranch = workspaceBranch;
  let currentWorkspaceLabel = initialWorkspaceLabel;
  let currentWorkspacePath = initialWorkspacePath;
  let currentWorkspacePullRequestNumber = workspacePullRequestNumber;
  let currentWorkspacePullRequestUrl = workspacePullRequestUrl;

  const defaultThinkingState = createDefaultThinkingState(threadTs);
  const defaultThinkingStateKey = JSON.stringify(defaultThinkingState);
  // Any activity drawn from the shared thinking pool (or the default status
  // itself) is "generic thinking" and must not promote the state to a
  // progress-message — even when runtime-ui's shuffle picks different entries
  // from the sink's initial shuffle.
  const genericThinkingActivities = new Set<string>([
    DEFAULT_ASSISTANT_THINKING_STATUS,
    ...THINKING_LOADING_MESSAGES,
  ]);

  const safeRender = async <T>(
    label: string,
    operation: () => Promise<T>,
  ): Promise<T | undefined> => {
    try {
      return await operation();
    } catch (error) {
      logger.warn('Failed to %s: %s', label, String(error));
      return undefined;
    }
  };

  const maybeRefreshWorkspaceContext = async (): Promise<void> => {
    const workspaceLabel = currentWorkspaceLabel;
    if (!currentWorkspacePath || !workspaceLabel) {
      return;
    }

    const nextMetadata = resolveWorkspaceDisplayMetadata(currentWorkspacePath);
    const changed =
      nextMetadata.workspaceBranch !== currentWorkspaceBranch ||
      nextMetadata.workspacePullRequestNumber !== currentWorkspacePullRequestNumber ||
      nextMetadata.workspacePullRequestUrl !== currentWorkspacePullRequestUrl;

    if (!changed) {
      return;
    }

    currentWorkspaceBranch = nextMetadata.workspaceBranch;
    currentWorkspacePullRequestNumber = nextMetadata.workspacePullRequestNumber;
    currentWorkspacePullRequestUrl = nextMetadata.workspacePullRequestUrl;

    if (!toolbarReply || !hasSentToolbarInTurn) {
      return;
    }

    const replyToUpdate = toolbarReply;
    const updatedReply = await safeRender('update assistant workspace context', () =>
      renderer.updateThreadReplyWorkspaceContext(client, channel, threadTs, replyToUpdate, {
        ...(currentWorkspaceBranch ? { workspaceBranch: currentWorkspaceBranch } : {}),
        workspaceLabel,
      }),
    );

    if (updatedReply) {
      toolbarReply = updatedReply;
      if (lastAssistantReply?.ts === updatedReply.ts) {
        lastAssistantReply = updatedReply;
      }
    }
  };

  const isMeaningfulActivityState = (state: AgentActivityState): boolean => {
    if (state.clear) return false;
    if (JSON.stringify(state) === defaultThinkingStateKey) return false;

    const normalizedStatus = state.status?.trim();
    if (normalizedStatus && normalizedStatus !== defaultThinkingState.status) return true;

    const meaningfulActivity = state.activities?.some((activity) => {
      const normalizedActivity = activity.trim();
      return (
        normalizedActivity.length > 0 &&
        normalizedActivity !== normalizedStatus &&
        !genericThinkingActivities.has(normalizedActivity)
      );
    });

    return meaningfulActivity === true;
  };

  const toRendererState = (state: AgentActivityState) => ({
    threadTs: state.threadTs,
    ...(state.status != null ? { status: state.status } : {}),
    ...(state.activities != null ? { loadingMessages: state.activities } : {}),
    ...(state.composing != null ? { composing: state.composing } : {}),
    ...(toolHistory.size > 0 ? { toolHistory } : {}),
    clear: state.clear ?? false,
  });

  const updateInFlightIndicator = async (state: AgentActivityState): Promise<void> => {
    if (progressMessageActive) {
      const nextProgressMessageTs = await safeRender('update thread progress message', () =>
        renderer.upsertThreadProgressMessage(
          client,
          channel,
          threadTs,
          toRendererState(state),
          progressMessageTs,
        ),
      );
      if (nextProgressMessageTs) {
        progressMessageTs = nextProgressMessageTs;
      }
      return;
    }
    await safeRender('set Slack UI state', () =>
      renderer.setUiState(client, channel, toRendererState(state)),
    );
  };

  const activateProgressMessage = async (state: AgentActivityState): Promise<void> => {
    if (!progressMessageActive) {
      progressMessageActive = true;
      await renderer.clearUiState(client, channel, threadTs).catch((error) => {
        logger.warn('Failed to clear fallback Slack thinking indicator: %s', String(error));
      });
    }
    const nextProgressMessageTs = await safeRender('activate thread progress message', () =>
      renderer.upsertThreadProgressMessage(
        client,
        channel,
        threadTs,
        toRendererState(state),
        progressMessageTs,
      ),
    );
    if (nextProgressMessageTs) {
      progressMessageTs = nextProgressMessageTs;
    }
  };

  const shouldPublishQuietAssistantMessage = (text: string): boolean => {
    return (
      text.includes('<@') ||
      quietAssistantPublicMentionIds.some((id) => id && text.includes(`<@${id}>`))
    );
  };

  const recordQuietAssistantMessage = async (text: string): Promise<void> => {
    await quietAssistantMessageRecorder
      ?.record({
        channelId: channel,
        createdAt: new Date().toISOString(),
        ...(executionId ? { executionId } : {}),
        ...(logLabel ? { logLabel } : {}),
        mode: 'quiet',
        reason: 'quiet_final_buffered',
        text,
        threadTs,
        ...(userId ? { userId } : {}),
      })
      .catch((error) => {
        logger.warn('Failed to record quiet A2A assistant message: %s', String(error));
      });
  };

  const postAssistantMessage = async (text: string): Promise<void> => {
    lastAssistantText = text;
    // Only include toolbar (workspaceLabel + toolHistory) on the first message of each turn
    const includeToolbar = !hasSentToolbarInTurn;
    await maybeRefreshWorkspaceContext();
    try {
      const postedReply = await renderer.postThreadReply(client, channel, threadTs, text, {
        ...(includeToolbar && currentWorkspaceBranch
          ? { workspaceBranch: currentWorkspaceBranch }
          : {}),
        ...(includeToolbar && currentWorkspaceLabel
          ? { workspaceLabel: currentWorkspaceLabel }
          : {}),
        ...(includeToolbar && currentWorkspacePullRequestNumber
          ? { workspacePullRequestNumber: currentWorkspacePullRequestNumber }
          : {}),
        ...(includeToolbar && currentWorkspacePullRequestUrl
          ? { workspacePullRequestUrl: currentWorkspacePullRequestUrl }
          : {}),
      });
      if (postedReply) {
        lastAssistantReply = postedReply;
        if (includeToolbar) {
          toolbarReply = postedReply;
        }
      }
      hasSentToolbarInTurn = true;
    } catch (error) {
      logger.warn('Failed to post assistant thread reply: %s', String(error));
    }
    if (pendingGeneratedFiles.length > 0) {
      const batch = [...pendingGeneratedFiles];
      try {
        pendingGeneratedFiles = await renderer.postGeneratedFiles(client, channel, threadTs, batch);
      } catch (error) {
        logger.warn('Failed to post generated files after assistant reply: %s', String(error));
      }
    }
    if (pendingGeneratedImages.length > 0) {
      const batch = [...pendingGeneratedImages];
      try {
        pendingGeneratedImages = await renderer.postGeneratedImages(
          client,
          channel,
          threadTs,
          batch,
        );
      } catch (error) {
        logger.warn('Failed to post generated images after assistant reply: %s', String(error));
      }
    }
    if (progressMessageActive && progressMessageTs) {
      await renderer
        .deleteThreadProgressMessage(client, channel, threadTs, progressMessageTs)
        .catch((error) => {
          logger.warn(
            'Failed to delete thread progress message after assistant reply: %s',
            String(error),
          );
        });
      progressMessageTs = undefined;
      progressMessageActive = false;
    }
    lastStateKey = undefined;
    toolHistory.clear();
    previousActivities = new Set<string>();
    await renderer.clearUiState(client, channel, threadTs).catch((error) => {
      logger.warn('Failed to clear UI state after assistant reply: %s', String(error));
    });
  };

  const handleAssistantMessage = async (text: string): Promise<void> => {
    if (assistantMessageVisibility === 'quiet-final' && !shouldPublishQuietAssistantMessage(text)) {
      quietAssistantMessages.push(text);
      await recordQuietAssistantMessage(text);
      if (!progressMessageActive) {
        await activateProgressMessage({
          activities: ['A2A update captured in diagnostics.'],
          status: 'Working in quiet A2A mode...',
          threadTs,
        });
      }
      return;
    }

    if (assistantMessageVisibility === 'quiet-final') {
      quietAssistantMessages.length = 0;
    }
    await postAssistantMessage(text);
  };

  const flushQuietAssistantMessage = async (): Promise<void> => {
    const text = quietAssistantMessages.at(-1);
    quietAssistantMessages.length = 0;
    if (!text) {
      return;
    }
    await postAssistantMessage(text);
  };

  const handleActivityState = async (state: AgentActivityState): Promise<void> => {
    await maybeRefreshWorkspaceContext();
    const nextStateKey = JSON.stringify(state);
    if (nextStateKey === lastStateKey) return;
    lastStateKey = nextStateKey;

    if (!state.clear) {
      previousActivities = collectToolActivity(state, toolHistory, previousActivities);
    }

    if (state.composing && !state.clear) {
      if (progressMessageActive && progressMessageTs) {
        await renderer
          .upsertThreadProgressMessage(
            client,
            channel,
            threadTs,
            {
              threadTs,
              status: 'Composing response...',
              loadingMessages: ['Composing response...'],
              ...(toolHistory.size > 0 ? { toolHistory } : {}),
              clear: false,
            },
            progressMessageTs,
          )
          .catch((error) => {
            logger.warn('Failed to update progress message on composing: %s', String(error));
          });
      } else {
        await renderer
          .setUiState(client, channel, { threadTs, status: 'Composing response...', clear: false })
          .catch((error) => {
            logger.warn('Failed to set composing status: %s', String(error));
          });
      }
      return;
    }

    if (state.clear) {
      if (progressMessageActive && progressMessageTs) {
        await safeRender('delete thread progress message', () =>
          renderer.deleteThreadProgressMessage(client, channel, threadTs, progressMessageTs!),
        );
        progressMessageTs = undefined;
        progressMessageActive = false;
        return;
      }
      await safeRender('clear Slack UI state', () =>
        renderer.clearUiState(client, channel, threadTs),
      );
      return;
    }

    if (!progressMessageActive && isMeaningfulActivityState(state)) {
      await activateProgressMessage(state);
      return;
    }

    await updateInFlightIndicator(state);
  };

  const handleLifecycleEvent = async (
    event: Extract<AgentExecutionEvent, { type: 'lifecycle' }>,
  ): Promise<void> => {
    if (event.resumeHandle) {
      sessionStore.patch(threadTs, { providerSessionId: event.resumeHandle });
    }
    if (event.phase === 'started') return;
    if (event.phase === 'completed') {
      terminalPhase = 'completed';
      executionCompletedSuccessfully = true;
      return;
    }
    if (event.phase === 'stopped') {
      terminalPhase = 'stopped';
      terminalStopReason = event.reason;
      if (event.reason !== 'superseded' && !progressMessageTs) {
        await safeRender('post stopped-by-user reply', () =>
          renderer.postThreadReply(client, channel, threadTs, '_Stopped by user._'),
        );
      }
      return;
    }
    if (event.phase === 'failed') {
      pendingGeneratedFiles = [];
      pendingGeneratedImages = [];
      terminalPhase = 'failed';
      runtimeError(
        logger,
        'Execution failed for thread %s: %s',
        threadTs,
        redact(String(event.error ?? '')),
      );
      await safeRender('post execution failure reply', () =>
        renderer.postThreadReply(
          client,
          channel,
          threadTs,
          formatClaudeExecutionFailureReply(event.error),
        ),
      );
    }
  };

  const handleWorkspaceContext = async (
    event: Extract<AgentExecutionEvent, { type: 'workspace-context' }>,
  ): Promise<void> => {
    currentWorkspacePath = event.workspacePath;
    currentWorkspaceLabel = event.workspaceLabel ?? currentWorkspaceLabel ?? event.workspacePath;

    sessionStore.patch(threadTs, {
      workspaceLabel: currentWorkspaceLabel,
      workspacePath: currentWorkspacePath,
      ...(event.workspaceRepoId ? { workspaceRepoId: event.workspaceRepoId } : {}),
    });

    const nextMetadata = resolveWorkspaceDisplayMetadata(currentWorkspacePath);
    currentWorkspaceBranch = nextMetadata.workspaceBranch;
    currentWorkspacePullRequestNumber = nextMetadata.workspacePullRequestNumber;
    currentWorkspacePullRequestUrl = nextMetadata.workspacePullRequestUrl;

    if (!toolbarReply || !hasSentToolbarInTurn) {
      return;
    }

    const updatedReply = await safeRender('update assistant workspace context', () =>
      renderer.updateThreadReplyWorkspaceContext(client, channel, threadTs, toolbarReply!, {
        ...(currentWorkspaceBranch ? { workspaceBranch: currentWorkspaceBranch } : {}),
        workspaceLabel: currentWorkspaceLabel!,
      }),
    );

    if (updatedReply) {
      toolbarReply = updatedReply;
      if (lastAssistantReply?.ts === updatedReply.ts) {
        lastAssistantReply = updatedReply;
      }
    }
  };

  function hasWorkspaceChanges(): boolean {
    const cwd = currentWorkspacePath;
    if (!cwd || !initialGitHead) return true; // no snapshot, assume changed
    try {
      const currentHead = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        timeout: 5_000,
      }).trim();
      if (currentHead !== initialGitHead) return true; // new commits
    } catch {
      return true;
    }
    try {
      const status = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], {
        encoding: 'utf8',
        timeout: 5_000,
      }).trim();
      if (status !== initialGitStatus) return true; // uncommitted changes differ
    } catch {
      return true;
    }
    return false;
  }

  return {
    toolHistory,
    ...(userInputBridge
      ? {
          requestUserInput: async (
            request: AgentUserInputRequest,
            requestOptions?: {
              description?: string | undefined;
              displayName?: string | undefined;
              signal?: AbortSignal | undefined;
              title?: string | undefined;
              toolUseId?: string | undefined;
            },
          ): Promise<AgentUserInputResponse> => {
            const answers: Record<string, string> = {};
            const annotations: NonNullable<AgentUserInputResponse['annotations']> = {};

            for (const [index, question] of request.questions.entries()) {
              await safeRender('set waiting-for-user-input UI state', () =>
                renderer.setUiState(client, channel, {
                  threadTs,
                  status: 'Waiting for your reply...',
                  loadingMessages: [
                    requestOptions?.title ?? 'Waiting for your reply in Slack...',
                    truncateForSlackUi(question.question),
                  ],
                  clear: false,
                }),
              );
              await safeRender('post user input question', () =>
                renderer.postThreadReply(
                  client,
                  channel,
                  threadTs,
                  formatUserInputQuestionMessage(question, {
                    currentIndex: index + 1,
                    description: requestOptions?.description,
                    displayName: requestOptions?.displayName,
                    title: requestOptions?.title,
                    totalQuestions: request.questions.length,
                  }),
                ),
              );

              const reply = await userInputBridge.awaitAnswer({
                expectedUserId: userId,
                question,
                signal: requestOptions?.signal,
                threadTs,
              });

              answers[question.question] = reply.answer;
              if (reply.annotation) {
                annotations[question.question] = reply.annotation;
              }
            }

            const defaultState = createDefaultThinkingState(threadTs);
            await safeRender('restore default thinking UI state', () =>
              renderer.setUiState(client, channel, {
                threadTs: defaultState.threadTs,
                status: defaultState.status,
                loadingMessages: defaultState.activities,
                clear: false,
              }),
            );

            return {
              answers,
              ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
            };
          },
        }
      : {}),
    ...(permissionBridge
      ? {
          requestPermission: async (
            request: AgentPermissionRequest,
            requestOptions?: {
              signal?: AbortSignal | undefined;
            },
          ): Promise<AgentPermissionResponse> =>
            permissionBridge.requestPermission(client, {
              channelId: channel,
              description: request.description,
              expectedUserId: userId,
              input: request.input,
              signal: requestOptions?.signal,
              threadTs,
              toolName: request.toolName,
            }),
        }
      : {}),

    get terminalPhase() {
      return terminalPhase;
    },

    get finalAssistantText() {
      return lastAssistantText;
    },

    async onEvent(event: AgentExecutionEvent): Promise<void> {
      if (event.type === 'workspace-context') {
        await handleWorkspaceContext(event);
        return;
      }
      if (event.type === 'assistant-message') {
        await handleAssistantMessage(event.text);
        return;
      }
      if (event.type === 'generated-images') {
        pendingGeneratedImages.push(...event.files);
        return;
      }
      if (event.type === 'generated-files') {
        pendingGeneratedFiles.push(...event.files);
        return;
      }
      if (event.type === 'activity-state') {
        await handleActivityState(event.state);
        return;
      }
      if (event.type === 'task-update') return;
      if (event.type === 'usage-info') {
        sessionUsageInfo = event.usage;
        return;
      }
      await handleLifecycleEvent(event as Extract<AgentExecutionEvent, { type: 'lifecycle' }>);
    },

    async finalize(): Promise<void> {
      await maybeRefreshWorkspaceContext();
      await renderer.clearUiState(client, channel, threadTs).catch((err) => {
        logger.warn('Failed to clear UI state: %s', String(err));
      });
      if (executionCompletedSuccessfully) {
        await flushQuietAssistantMessage();
      }
      if (executionCompletedSuccessfully && pendingGeneratedFiles.length > 0) {
        const batch = [...pendingGeneratedFiles];
        try {
          pendingGeneratedFiles = await renderer.postGeneratedFiles(
            client,
            channel,
            threadTs,
            batch,
          );
        } catch (err) {
          logger.warn('Failed to flush generated files on finalize: %s', String(err));
        }
      }
      if (executionCompletedSuccessfully && pendingGeneratedImages.length > 0) {
        const batch = [...pendingGeneratedImages];
        try {
          pendingGeneratedImages = await renderer.postGeneratedImages(
            client,
            channel,
            threadTs,
            batch,
          );
        } catch (err) {
          logger.warn('Failed to flush generated images on finalize: %s', String(err));
        }
      }
      if (progressMessageTs) {
        if (terminalPhase === 'stopped') {
          if (terminalStopReason === 'superseded') {
            await renderer
              .deleteThreadProgressMessage(client, channel, threadTs, progressMessageTs)
              .catch((err) => {
                logger.warn('Failed to delete superseded progress message: %s', String(err));
              });
          } else {
            await renderer
              .finalizeThreadProgressMessageStopped(
                client,
                channel,
                threadTs,
                progressMessageTs,
                toolHistory,
              )
              .catch((err) => {
                logger.warn('Failed to finalize stopped progress message: %s', String(err));
              });
          }
        } else {
          await renderer
            .finalizeThreadProgressMessage(
              client,
              channel,
              threadTs,
              progressMessageTs,
              toolHistory,
            )
            .catch((err) => {
              logger.warn('Failed to finalize progress message: %s', String(err));
            });
        }
      }
      // Attach session usage to the final assistant reply so multi-agent threads
      // do not interleave detached usage-only messages between agent replies.
      if (executionCompletedSuccessfully && sessionUsageInfo) {
        let usageAttached = false;
        if (lastAssistantReply) {
          usageAttached =
            (await renderer
              .appendSessionUsageInfoToThreadReply(
                client,
                channel,
                threadTs,
                lastAssistantReply,
                sessionUsageInfo,
                {
                  ...(currentWorkspacePullRequestNumber
                    ? { workspacePullRequestNumber: currentWorkspacePullRequestNumber }
                    : {}),
                  ...(currentWorkspacePullRequestUrl
                    ? { workspacePullRequestUrl: currentWorkspacePullRequestUrl }
                    : {}),
                },
              )
              .catch((err) => {
                logger.warn('Failed to append session usage info: %s', String(err));
                return false;
              })) === true;
        }
        if (!usageAttached) {
          await renderer
            .postSessionUsageInfo(client, channel, threadTs, sessionUsageInfo, {
              ...(currentWorkspacePullRequestNumber
                ? { workspacePullRequestNumber: currentWorkspacePullRequestNumber }
                : {}),
              ...(currentWorkspacePullRequestUrl
                ? { workspacePullRequestUrl: currentWorkspacePullRequestUrl }
                : {}),
            })
            .catch((err) => {
              logger.warn('Failed to post session usage info: %s', String(err));
            });
        }
      }
      if (sessionUsageInfo && analyticsStore) {
        try {
          analyticsStore.upsert(threadTs, userId, sessionUsageInfo);
        } catch (err) {
          logger.warn('Failed to persist session analytics: %s', String(err));
        }
      }
      if (executionCompletedSuccessfully && reviewUrl && hasWorkspaceChanges()) {
        await renderer.postReviewPanelLink(client, channel, threadTs, reviewUrl).catch((err) => {
          logger.warn('Failed to post review panel link: %s', String(err));
        });
      }
    },
  };
}

function truncateForSlackUi(value: string, maxLength = 120): string {
  const normalized = value.trim().replaceAll(/\s+/g, ' ');
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatUserInputQuestionMessage(
  question: AgentUserInputQuestion,
  options: {
    currentIndex: number;
    description?: string | undefined;
    displayName?: string | undefined;
    title?: string | undefined;
    totalQuestions: number;
  },
): string {
  const header = [
    '*Skill 需要你的输入*',
    options.totalQuestions > 1
      ? `_问题 ${options.currentIndex}/${options.totalQuestions}_`
      : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  const intro = options.title ?? options.displayName ?? 'Claude 需要你提供一个选项。';
  const details = options.description ? [`${intro}`, '', options.description] : [intro];
  const optionLines = question.options.map((option, index) => {
    const description = option.description ? ` — ${option.description}` : '';
    return `${index + 1}. *${option.label}*${description}`;
  });
  const replyHint = question.multiSelect
    ? '请回复编号或标签，多个选项用逗号分隔；如果都不合适，也可以直接回复自由文本。'
    : '请回复编号或标签；如果都不合适，也可以直接回复自由文本。';

  return [
    header,
    '',
    ...details,
    '',
    `*${question.header}*`,
    question.question,
    '',
    ...optionLines,
    '',
    replyHint,
  ].join('\n');
}

function createDefaultThinkingState(threadTs: string): AgentActivityState {
  return {
    threadTs,
    status: DEFAULT_ASSISTANT_THINKING_STATUS,
    activities: getShuffledThinkingMessages(),
    clear: false,
  };
}

function collectToolActivity(
  state: AgentActivityState,
  history: Map<string, number>,
  previousActivities: Set<string>,
): Set<string> {
  const candidates = [...(state.activities ?? [])];
  if (state.status?.trim()) candidates.push(state.status);

  const currentActivities = new Set<string>();

  for (const msg of candidates) {
    const trimmed = msg.trim();
    if (!trimmed || currentActivities.has(trimmed)) continue;
    currentActivities.add(trimmed);

    // Only count activities that are newly appearing (not in previous state)
    if (previousActivities.has(trimmed)) continue;

    const match = trimmed.match(TOOL_VERB_PATTERN);
    if (!match) continue;

    const verb = match[1]!;
    const label = verb === 'Using' ? (match[2]!.split(/\s/)[0] ?? verb) : verb;
    history.set(label, (history.get(label) ?? 0) + 1);
  }

  return currentActivities;
}
