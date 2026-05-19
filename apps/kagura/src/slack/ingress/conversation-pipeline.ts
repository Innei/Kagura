import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { AgentExecutionEvent, AgentExecutor } from '~/agent/types.js';
import { appRuntimeConfig } from '~/env/server.js';
import { redact } from '~/logger/redact.js';
import { runtimeError, runtimeInfo, runtimeWarn } from '~/logger/runtime.js';
import {
  createReviewSessionSnapshot,
  resolveGitBranch,
  resolveGitHead,
} from '~/review/git-review-service.js';
import type { SessionRecord } from '~/session/types.js';
import { formatClaudeExecutionFailureReply } from '~/util/error-detail.js';
import { enrichResolvedWorkspace } from '~/workspace/resolver.js';

import type { ThreadExecutionStopReason } from '../execution/thread-execution-registry.js';
import type { SlackWebClientLike } from '../types.js';
import { type ActivitySink, createActivitySink } from './activity-sink.js';
import { getA2AContextFromSession, serializeA2AParticipants } from './scenarios/a2a/routing.js';
import { resolveAndPersistSession } from './session-manager.js';
import type {
  ConversationPipelineContext,
  PipelineStep,
  PipelineStepResult,
  SlackIngressDependencies,
  ThreadConversationMessage,
  ThreadConversationOptions,
} from './types.js';
import {
  buildWorkspaceResolutionBlocks,
  resolveWorkspaceForConversation,
} from './workspace-resolution.js';

export async function runConversationPipeline(
  ctx: ConversationPipelineContext,
  steps: PipelineStep[],
): Promise<void> {
  for (const step of steps) {
    const result = await step(ctx);
    if (result.action === 'done') return;
  }
}

export async function handleThreadConversation(
  client: SlackWebClientLike,
  message: ThreadConversationMessage,
  deps: SlackIngressDependencies,
  options: ThreadConversationOptions,
): Promise<void> {
  const ctx: ConversationPipelineContext = {
    client,
    deps,
    message,
    options,
    threadTs: message.thread_ts ?? message.ts,
  };
  await runConversationPipeline(ctx, DEFAULT_CONVERSATION_STEPS);
}

const CONTINUE: PipelineStepResult = { action: 'continue' };

export async function acknowledgeAndLog(
  ctx: ConversationPipelineContext,
): Promise<PipelineStepResult> {
  const { deps, message, options, threadTs } = ctx;

  runtimeInfo(
    deps.logger,
    'Received %s in channel %s, root ts %s, thread ts %s',
    options.logLabel,
    message.channel,
    message.ts,
    threadTs,
  );

  ctx.existingSession = deps.sessionStore.get(threadTs);

  if (!deps.threadExecutionRegistry.claimMessage(message.ts, threadTs)) {
    runtimeInfo(
      deps.logger,
      'Skipping %s for thread %s because message %s was already claimed by ingress',
      options.logLabel,
      threadTs,
      message.ts,
    );
    return { action: 'done', reason: 'duplicate ingress message' };
  }

  if (options.addAcknowledgementReaction) {
    await deps.renderer.addAcknowledgementReaction(ctx.client, message.channel, message.ts);
  }

  return CONTINUE;
}

const STOP_KEYWORDS: ReadonlySet<string> = new Set(['stop', 'cancel']);

function normalizeStopKeyword(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const stripped = text
    .replaceAll(/<@[^>]+>/g, '')
    .replace(/[.!?。！？]+$/u, '')
    .trim()
    .toLowerCase();
  return stripped.length > 0 ? stripped : undefined;
}

export async function handleStopKeywordStep(
  ctx: ConversationPipelineContext,
): Promise<PipelineStepResult> {
  const { client, deps, message, options, threadTs } = ctx;
  const keyword = normalizeStopKeyword(message.text);
  if (!keyword || !STOP_KEYWORDS.has(keyword)) {
    return CONTINUE;
  }

  runtimeInfo(
    deps.logger,
    'Stop keyword %s detected in thread %s — cancelling active executions',
    keyword,
    threadTs,
  );

  const result = await deps.threadExecutionRegistry.stopAll(threadTs, 'user_stop');
  runtimeInfo(
    deps.logger,
    'Stop keyword in thread %s: stopped=%d failed=%d',
    threadTs,
    result.stopped,
    result.failed,
  );

  if (options.addAcknowledgementReaction) {
    await deps.renderer
      .removeAcknowledgementReaction(client, message.channel, message.ts)
      .catch((error) => {
        deps.logger.warn(
          'Failed to remove acknowledgement reaction after stop keyword: %s',
          String(error),
        );
      });
  }

  await client.reactions
    .add({
      channel: message.channel,
      name: 'octagonal_sign',
      timestamp: message.ts,
    })
    .catch((error) => {
      deps.logger.warn('Failed to add stop reaction to user message: %s', String(error));
    });

  return { action: 'done', reason: 'user stop keyword' };
}

export async function stopActiveExecutionsStep(
  ctx: ConversationPipelineContext,
): Promise<PipelineStepResult> {
  const { deps, threadTs } = ctx;
  const active = deps.threadExecutionRegistry.listActive(threadTs);
  const result = await deps.threadExecutionRegistry.stopAll(threadTs, 'superseded');
  if (active.length === 0 && result.stopped === 0 && result.failed === 0) {
    return CONTINUE;
  }

  if (active.length > 0) {
    runtimeInfo(
      deps.logger,
      'Stopping %d active execution(s) in thread %s before processing new message',
      active.length,
      threadTs,
    );
  } else {
    runtimeInfo(
      deps.logger,
      'Waiting for in-flight execution shutdown to finish in thread %s before processing new message',
      threadTs,
    );
  }
  runtimeInfo(
    deps.logger,
    'Stopped %d execution(s) in thread %s (failed=%d)',
    result.stopped,
    threadTs,
    result.failed,
  );

  // Refresh session from store — the stopped execution may have persisted a new providerSessionId
  ctx.existingSession = deps.sessionStore.get(threadTs);

  return CONTINUE;
}

export async function resolveWorkspaceStep(
  ctx: ConversationPipelineContext,
): Promise<PipelineStepResult> {
  const { deps, message, threadTs } = ctx;

  const workspaceResolution = resolveWorkspaceForConversation(
    message.text,
    ctx.existingSession,
    deps.workspaceResolver,
    deps.channelPreferenceStore,
    message.channel,
    ctx.options.workspaceOverride,
  );

  if (workspaceResolution.status === 'ambiguous') {
    runtimeWarn(
      deps.logger,
      'Ambiguous workspace for thread %s (%s)',
      threadTs,
      workspaceResolution.reason,
    );
    const { blocks, text } = buildWorkspaceResolutionBlocks(workspaceResolution, message.text);
    await ctx.client.chat.postMessage({
      blocks,
      channel: message.channel,
      text,
      thread_ts: threadTs,
    });
    return { action: 'done', reason: 'ambiguous workspace' };
  }

  ctx.workspace =
    workspaceResolution.status === 'unique'
      ? enrichResolvedWorkspace(workspaceResolution.workspace)
      : undefined;

  if (workspaceResolution.status === 'missing') {
    runtimeInfo(
      deps.logger,
      'No workspace detected for thread %s — proceeding without workspace (%s)',
      threadTs,
      workspaceResolution.reason,
    );
  }

  return CONTINUE;
}

export async function resolveSessionStep(
  ctx: ConversationPipelineContext,
): Promise<PipelineStepResult> {
  const { deps, message, options, threadTs, workspace } = ctx;
  const a2aFields = options.a2aContext
    ? {
        a2aLead: options.a2aContext.lead,
        a2aParticipantsJson: serializeA2AParticipants(options.a2aContext),
        ...(options.a2aContext.teamId ? { a2aTeamId: options.a2aContext.teamId } : {}),
        conversationMode: 'a2a' as const,
      }
    : {};

  const { resumeHandle, session } = resolveAndPersistSession(
    threadTs,
    message.channel,
    options.rootMessageTs,
    workspace,
    options.forceNewSession === true,
    deps.sessionStore,
  );
  ctx.resumeHandle = options.resumeHandleOverride ?? resumeHandle;
  ctx.previousTurnTriggerTs = resumeHandle ? session.lastTurnTriggerTs : undefined;

  deps.sessionStore.patch(threadTs, {
    ...a2aFields,
    ...(options.agentProviderOverride ? { agentProvider: options.agentProviderOverride } : {}),
    lastTurnTriggerTs: message.ts,
  });
  ctx.existingSession = deps.sessionStore.get(threadTs) ?? ctx.existingSession;

  return CONTINUE;
}

export async function prepareThreadContext(
  ctx: ConversationPipelineContext,
): Promise<PipelineStepResult> {
  const { client, deps, message, threadTs, workspace } = ctx;

  await deps.renderer.showThinkingIndicator(client, message.channel, threadTs).catch((error) => {
    deps.logger.warn('Failed to show Slack thinking indicator: %s', String(error));
  });

  runtimeInfo(deps.logger, 'Loading thread context for %s', threadTs);
  ctx.threadContext = await deps.threadContextLoader.loadThread(client, message.channel, threadTs);
  runtimeInfo(
    deps.logger,
    'Thread context loaded for %s (%d messages)',
    threadTs,
    ctx.threadContext.messages.length,
  );

  ctx.contextMemories = deps.memoryStore.listForContext(workspace?.repo.id);

  return CONTINUE;
}

export async function executeAgent(ctx: ConversationPipelineContext): Promise<PipelineStepResult> {
  const {
    client,
    deps,
    message,
    threadTs,
    workspace,
    resumeHandle,
    threadContext,
    contextMemories,
  } = ctx;

  if (!threadContext) {
    throw new Error('Pipeline invariant: threadContext must be set before executeAgent');
  }

  if (ctx.options.addAcknowledgementReaction) {
    await deps.renderer
      .removeAcknowledgementReaction(client, message.channel, message.ts)
      .catch((error) => {
        deps.logger.warn('Failed to remove acknowledgement reaction: %s', String(error));
      });
  }

  const executor = resolveExecutor(ctx.existingSession, deps, ctx.options.agentProviderOverride);
  const executionId = ctx.options.executionId ?? randomUUID();
  const reviewUrl =
    workspace && deps.reviewSessionStore && deps.reviewPanelBaseUrl
      ? `${deps.reviewPanelBaseUrl.replace(/\/$/, '')}/reviews/${encodeURIComponent(executionId)}`
      : undefined;
  const a2aContext = ctx.options.a2aContext ?? getA2AContextFromSession(ctx.existingSession ?? {});
  const quietA2A =
    deps.a2aOutputMode === 'quiet' &&
    Boolean(a2aContext || ctx.options.a2aAssignmentId || ctx.options.a2aSummaryAssignmentId);
  const workspacePath = workspace?.workspacePath;
  let currentWorkspacePath = workspacePath;
  const initialGitHead = workspacePath ? resolveGitHead(workspacePath) : undefined;
  let initialGitStatus: string | undefined;
  if (workspacePath) {
    try {
      initialGitStatus =
        execFileSync('git', ['-C', workspacePath, 'status', '--porcelain'], {
          encoding: 'utf8',
          timeout: 5_000,
        }).trim() || undefined;
    } catch {
      // not a git repo or git unavailable
    }
  }
  const baseSink = createActivitySink({
    analyticsStore: deps.analyticsStore,
    assistantMessageVisibility: quietA2A ? 'quiet-final' : 'public',
    channel: message.channel,
    client,
    executionId,
    initialGitHead,
    initialGitStatus,
    logger: deps.logger,
    logLabel: ctx.options.logLabel,
    permissionBridge: deps.permissionBridge,
    quietAssistantMessageRecorder: deps.a2aQuietMessageRecorder,
    quietAssistantPublicMentionIds: a2aContext?.participants,
    renderer: deps.renderer,
    sessionStore: deps.sessionStore,
    taskCardBlocksEnabled: appRuntimeConfig.slack.taskCardBlocksEnabled,
    threadTs,
    userId: message.user,
    userInputBridge: deps.userInputBridge,
    ...(workspace?.workspaceBranch ? { workspaceBranch: workspace.workspaceBranch } : {}),
    ...(workspace?.workspacePullRequestNumber
      ? { workspacePullRequestNumber: workspace.workspacePullRequestNumber }
      : {}),
    ...(workspace?.workspacePullRequestUrl
      ? { workspacePullRequestUrl: workspace.workspacePullRequestUrl }
      : {}),
    ...(workspace ? { workspacePath: workspace.workspacePath } : {}),
    ...(workspace ? { workspaceLabel: workspace.workspaceLabel } : {}),
    ...(reviewUrl ? { reviewUrl } : {}),
  });
  const sink = createPersistentExecutionSink(baseSink, deps, executionId, {
    onWorkspaceContext: (event) => {
      currentWorkspacePath = event.workspacePath;
    },
  });

  const controller = new AbortController();
  const startedAt = new Date().toISOString();
  let executionReleasedFromRegistry = false;
  let resolveExecutionDone: () => void;
  const executionDone = new Promise<void>((resolve) => {
    resolveExecutionDone = resolve;
  });
  const releaseExecutionFromRegistry = () => {
    if (executionReleasedFromRegistry) {
      return;
    }
    executionReleasedFromRegistry = true;
    unregisterExecution();
  };

  const unregisterExecution = deps.threadExecutionRegistry.register({
    channelId: message.channel,
    completionPromise: executionDone,
    executionId,
    providerId: executor.providerId,
    startedAt,
    stop: async (reason?: ThreadExecutionStopReason) => {
      runtimeInfo(
        deps.logger,
        'Abort requested for execution %s in thread %s (reason=%s)',
        executionId,
        threadTs,
        reason ?? 'user_stop',
      );
      releaseExecutionFromRegistry();
      controller.abort(reason ?? 'user_stop');
    },
    threadTs,
    userId: message.user,
  });

  deps.threadExecutionRegistry.trackMessage(message.ts, threadTs);
  deps.persistentExecutionStore?.start({
    channelId: message.channel,
    executionId,
    messageTs: message.ts,
    providerId: executor.providerId,
    rootMessageTs: ctx.options.rootMessageTs,
    startedAt,
    ...(message.team ? { teamId: message.team } : {}),
    text: message.text,
    threadTs,
    userId: message.user,
  });
  if (workspace && deps.reviewSessionStore) {
    deps.reviewSessionStore.start({
      baseBranch: resolveGitBranch(workspace.workspacePath),
      baseHead: resolveGitHead(workspace.workspacePath),
      channelId: message.channel,
      createdAt: startedAt,
      executionId,
      threadTs,
      workspaceLabel: workspace.workspaceLabel,
      workspacePath: workspace.workspacePath,
      workspaceRepoId: workspace.repo.id,
    });
  }

  try {
    runtimeInfo(
      deps.logger,
      'Starting agent execution %s for thread %s (provider=%s resume=%s workspace=%s)',
      executionId,
      threadTs,
      executor.providerId,
      resumeHandle ?? 'none',
      workspace?.workspaceLabel ?? '(none)',
    );
    await executor.execute(
      {
        abortSignal: controller.signal,
        channelId: message.channel,
        currentTriggerTs: message.ts,
        executionId,
        threadTs,
        userId: message.user,
        mentionText: message.text,
        threadContext,
        ...(ctx.existingSession?.agentModel
          ? { modelOverride: ctx.existingSession.agentModel }
          : {}),
        ...(contextMemories ? { contextMemories } : {}),
        ...(workspace
          ? {
              ...(workspace.workspaceBranch ? { workspaceBranch: workspace.workspaceBranch } : {}),
              workspaceLabel: workspace.workspaceLabel,
              workspacePath: workspace.workspacePath,
              workspaceRepoId: workspace.repo.id,
            }
          : {}),
        ...(resumeHandle ? { resumeHandle } : {}),
        ...(ctx.previousTurnTriggerTs ? { previousTurnTriggerTs: ctx.previousTurnTriggerTs } : {}),
        ...(ctx.options.currentBotUserName ? { botUserName: ctx.options.currentBotUserName } : {}),
        ...(ctx.options.currentBotUserId ? { botUserId: ctx.options.currentBotUserId } : {}),
        ...(a2aContext
          ? {
              a2aContext: {
                leadId: a2aContext.lead,
                participants: a2aContext.roster.map((participant) => ({
                  id: participant.id,
                  isCurrentAgent:
                    Boolean(ctx.options.currentBotUserId) &&
                    participant.id === ctx.options.currentBotUserId,
                  isLead: participant.id === a2aContext.lead,
                  ...(participant.label ? { label: participant.label } : {}),
                  ...(participant.role ? { role: participant.role } : {}),
                })),
                ...(a2aContext.teamId ? { teamId: a2aContext.teamId } : {}),
              },
            }
          : {}),
      },
      sink,
    );
    runtimeInfo(deps.logger, 'Agent execution %s completed for thread %s', executionId, threadTs);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    runtimeError(
      deps.logger,
      'Agent execution %s failed for thread %s: %s',
      executionId,
      threadTs,
      redact(errorMessage),
    );
    await deps.renderer.postThreadReply(
      client,
      message.channel,
      threadTs,
      formatClaudeExecutionFailureReply(errorMessage),
    );
  } finally {
    runtimeInfo(
      deps.logger,
      'Finalizing agent execution %s for thread %s (terminalPhase=%s)',
      executionId,
      threadTs,
      sink.terminalPhase ?? 'unknown',
    );
    releaseExecutionFromRegistry();
    await sink.finalize();
    if (ctx.options.a2aAssignmentId && ctx.options.currentBotUserId && deps.a2aCoordinatorStore) {
      const terminalPhase =
        sink.terminalPhase === 'completed' ||
        sink.terminalPhase === 'failed' ||
        sink.terminalPhase === 'stopped'
          ? sink.terminalPhase
          : 'failed';
      deps.a2aCoordinatorStore.markAgentTerminal(
        ctx.options.a2aAssignmentId,
        ctx.options.currentBotUserId,
        terminalPhase,
      );
    }
    if (ctx.options.a2aSummaryAssignmentId && deps.a2aCoordinatorStore) {
      deps.a2aCoordinatorStore.markSummaryCompleted(ctx.options.a2aSummaryAssignmentId);
    }
    if (ctx.options.addAcknowledgementReaction && sink.terminalPhase === 'completed') {
      await deps.renderer
        .addCompletionReaction(client, message.channel, message.ts)
        .catch((error) => {
          deps.logger.warn('Failed to add completion reaction: %s', String(error));
        });
    }
    deps.persistentExecutionStore?.markTerminal(
      executionId,
      normalizeTerminalPhase(sink.terminalPhase),
      sink.terminalPhase,
    );
    const terminalStatus = normalizeTerminalPhase(sink.terminalPhase);
    const finalHead = currentWorkspacePath ? resolveGitHead(currentWorkspacePath) : undefined;
    const reviewSession = deps.reviewSessionStore?.get(executionId);
    const reviewSnapshot =
      reviewSession && terminalStatus === 'completed'
        ? createReviewSessionSnapshot({
            ...reviewSession,
            ...(currentWorkspacePath ? { workspacePath: currentWorkspacePath } : {}),
            ...(finalHead ? { head: finalHead } : {}),
          })
        : undefined;
    deps.reviewSessionStore?.complete(executionId, terminalStatus, {
      ...reviewSnapshot,
      ...(finalHead ? { head: finalHead } : {}),
    });
    triggerMemoryIngestion(ctx, executionId, executor.providerId, sink);
    resolveExecutionDone!();
    runtimeInfo(
      deps.logger,
      'Execution %s finalize completed for thread %s',
      executionId,
      threadTs,
    );
  }

  return CONTINUE;
}

function createPersistentExecutionSink(
  baseSink: ActivitySink,
  deps: SlackIngressDependencies,
  executionId: string,
  options?: {
    onWorkspaceContext?: (
      event: Extract<AgentExecutionEvent, { type: 'workspace-context' }>,
    ) => void;
  },
): ActivitySink {
  return {
    finalize: () => baseSink.finalize(),
    onEvent: async (event: AgentExecutionEvent) => {
      if (event.type === 'lifecycle' && event.resumeHandle) {
        deps.persistentExecutionStore?.recordResumeHandle(executionId, event.resumeHandle);
      }
      if (event.type === 'workspace-context') {
        options?.onWorkspaceContext?.(event);
        deps.reviewSessionStore?.updateWorkspaceContext?.(executionId, {
          baseBranch: resolveGitBranch(event.workspacePath),
          baseHead: resolveGitHead(event.workspacePath),
          ...(event.workspaceLabel ? { workspaceLabel: event.workspaceLabel } : {}),
          workspacePath: event.workspacePath,
          ...(event.workspaceRepoId ? { workspaceRepoId: event.workspaceRepoId } : {}),
        });
      }
      await baseSink.onEvent(event);
    },
    ...(baseSink.requestPermission
      ? { requestPermission: baseSink.requestPermission.bind(baseSink) }
      : {}),
    ...(baseSink.requestUserInput
      ? { requestUserInput: baseSink.requestUserInput.bind(baseSink) }
      : {}),
    get terminalPhase() {
      return baseSink.terminalPhase;
    },
    get finalAssistantText() {
      return baseSink.finalAssistantText;
    },
    get toolHistory() {
      return baseSink.toolHistory;
    },
  };
}

function triggerMemoryIngestion(
  ctx: ConversationPipelineContext,
  executionId: string,
  providerId: string,
  sink: ActivitySink,
): void {
  if (sink.terminalPhase !== 'completed') {
    return;
  }
  const finalAssistantText = sink.finalAssistantText?.trim();
  if (!finalAssistantText || !ctx.deps.memoryIngestionService) {
    return;
  }
  void ctx.deps.memoryIngestionService
    .ingest({
      channelId: ctx.message.channel,
      executionId,
      finalAssistantText,
      messageTs: ctx.message.ts,
      providerId,
      threadTs: ctx.threadTs,
      userText: ctx.message.text,
      ...(ctx.workspace
        ? {
            workspace: {
              label: ctx.workspace.workspaceLabel,
              path: ctx.workspace.workspacePath,
              repoId: ctx.workspace.repo.id,
            },
          }
        : {}),
    })
    .catch((error) => {
      ctx.deps.logger.warn(
        'Memory ingestion failed for execution %s: %s',
        executionId,
        error instanceof Error ? error.message : String(error),
      );
    });
}

function normalizeTerminalPhase(
  terminalPhase: ActivitySink['terminalPhase'],
): 'completed' | 'failed' | 'stopped' {
  if (terminalPhase === 'completed' || terminalPhase === 'failed' || terminalPhase === 'stopped') {
    return terminalPhase;
  }
  return 'failed';
}

function resolveExecutor(
  session: SessionRecord | undefined,
  deps: SlackIngressDependencies,
  providerOverride: string | undefined,
): AgentExecutor {
  if (providerOverride && deps.providerRegistry?.has(providerOverride)) {
    return deps.providerRegistry.getExecutor(providerOverride);
  }
  if (session?.agentProvider && deps.providerRegistry?.has(session.agentProvider)) {
    return deps.providerRegistry.getExecutor(session.agentProvider);
  }
  return deps.claudeExecutor;
}

export const DEFAULT_CONVERSATION_STEPS: PipelineStep[] = [
  acknowledgeAndLog,
  handleStopKeywordStep,
  stopActiveExecutionsStep,
  resolveWorkspaceStep,
  resolveSessionStep,
  prepareThreadContext,
  executeAgent,
];
