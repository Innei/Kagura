import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { CanUseTool, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';

import type { AgentExecutionRequest, AgentExecutionSink, AgentExecutor } from '~/agent/types.js';
import type { ChannelPreferenceStore } from '~/channel-preference/types.js';
import { env } from '~/env/server.js';
import type { AppLogger } from '~/logger/index.js';
import { redact } from '~/logger/redact.js';
import type { MemoryStore } from '~/memory/types.js';

import type { ClaudeExecutionProbe, ClaudeExecutionProbeRecord } from './execution-probe.js';
import { createAnthropicAgentSdkMcpServer } from './mcp-server.js';
import { handleClaudeSdkMessage } from './messages.js';
import { createClaudePromptInput } from './prompt-input.js';
import { buildRuntimeUiState, createRuntimeUiStateTracker } from './runtime-ui.js';
import type { MessageHandlers, RuntimeUiStateTracker } from './types.js';

function createAbortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

const execFileAsync = promisify(execFile);
const ABORT_TEARDOWN_TIMEOUT_MS = 1_000;

interface ClaudeAuthStatus {
  apiProvider?: string;
  authMethod?: string;
  email?: string;
  loggedIn?: boolean;
  orgName?: string;
  subscriptionType?: string;
}

interface ClaudeRuntimeConfigSummary {
  anthropicBaseUrl: string | undefined;
  anthropicDefaultHaikuModel: string | undefined;
  anthropicDefaultOpusModel: string | undefined;
  anthropicDefaultSonnetModel: string | undefined;
  anthropicModel: string | undefined;
  claudeModel: string | undefined;
}

function getClaudeRuntimeConfigSummary(): ClaudeRuntimeConfigSummary {
  return {
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL?.trim() || undefined,
    anthropicDefaultHaikuModel: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL?.trim() || undefined,
    anthropicDefaultOpusModel: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL?.trim() || undefined,
    anthropicDefaultSonnetModel: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL?.trim() || undefined,
    anthropicModel: process.env.ANTHROPIC_MODEL?.trim() || undefined,
    claudeModel: env.CLAUDE_MODEL,
  };
}

async function nextMessageOrAbort<T>(
  iterator: AsyncIterator<T>,
  signal?: AbortSignal,
): Promise<IteratorResult<T>> {
  if (!signal) {
    return iterator.next();
  }
  if (signal.aborted) {
    throw createAbortError();
  }
  let onAbort: (() => void) | undefined;
  const nextPromise = iterator.next();
  const abortPromise = new Promise<IteratorResult<T>>((_, reject) => {
    onAbort = () => reject(createAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([nextPromise, abortPromise]);
  } catch (error) {
    if (isAbortError(error)) {
      void nextPromise.catch(() => {
        /* avoid unhandled rejection when abort wins the race */
      });
    }
    throw error;
  } finally {
    if (onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

async function disposeAsyncIterator(
  iterator: AsyncIterator<SDKMessage> | undefined,
  options?: {
    executionId?: string | undefined;
    logger?: AppLogger | undefined;
    threadTs?: string | undefined;
    timeoutMs?: number | undefined;
  },
): Promise<void> {
  if (!iterator?.return) {
    return;
  }
  try {
    const returnPromise = iterator.return();
    const timeoutMs = options?.timeoutMs ?? ABORT_TEARDOWN_TIMEOUT_MS;
    const startedAt = Date.now();
    options?.logger?.info(
      'Starting Claude SDK iterator teardown via return() (execution=%s thread=%s timeoutMs=%d)',
      options.executionId ?? 'unknown',
      options.threadTs ?? 'unknown',
      timeoutMs,
    );
    const result = await Promise.race([
      returnPromise.then(() => 'completed' as const),
      new Promise<'timed_out'>((resolve) => {
        setTimeout(() => resolve('timed_out'), timeoutMs);
      }),
    ]);
    if (result === 'timed_out') {
      options?.logger?.warn(
        'Claude SDK iterator teardown timed out after %dms (execution=%s thread=%s)',
        Date.now() - startedAt,
        options.executionId ?? 'unknown',
        options.threadTs ?? 'unknown',
      );
      return;
    }
    options?.logger?.info(
      'Claude SDK iterator teardown completed in %dms (execution=%s thread=%s)',
      Date.now() - startedAt,
      options.executionId ?? 'unknown',
      options.threadTs ?? 'unknown',
    );
  } catch {
    /* ignore teardown errors */
  }
}

async function interruptQuery(
  session: ReturnType<typeof query> | undefined,
  logger: AppLogger,
  threadTs: string,
  executionId: string,
): Promise<void> {
  if (!session) {
    return;
  }

  try {
    const startedAt = Date.now();
    logger.info(
      'Interrupting Claude SDK query (execution=%s thread=%s timeoutMs=%d)',
      executionId,
      threadTs,
      ABORT_TEARDOWN_TIMEOUT_MS,
    );
    const result = await Promise.race([
      session.interrupt().then(() => 'completed' as const),
      new Promise<'timed_out'>((resolve) => {
        setTimeout(() => resolve('timed_out'), ABORT_TEARDOWN_TIMEOUT_MS);
      }),
    ]);
    if (result === 'timed_out') {
      logger.warn(
        'Claude SDK interrupt timed out after %dms (execution=%s thread=%s)',
        Date.now() - startedAt,
        executionId,
        threadTs,
      );
      return;
    }
    logger.info(
      'Claude SDK interrupt completed in %dms (execution=%s thread=%s)',
      Date.now() - startedAt,
      executionId,
      threadTs,
    );
  } catch (error) {
    logger.warn(
      'Failed to interrupt Claude SDK query during abort (execution=%s thread=%s): %s',
      executionId,
      threadTs,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export class ClaudeAgentSdkExecutor implements AgentExecutor {
  readonly providerId = 'claude-code';
  private readonly activeExecutions = new Set<Promise<void>>();

  constructor(
    private readonly logger: AppLogger,
    private readonly memoryStore: MemoryStore,
    private readonly channelPreferenceStore: ChannelPreferenceStore,
    private readonly executionProbe?: ClaudeExecutionProbe,
    private readonly options?: {
      permissionMode?: typeof env.CLAUDE_PERMISSION_MODE | undefined;
    },
  ) {
    void this.logClaudeAuthStatus();
    this.logClaudeRuntimeConfig();
  }

  async drain(): Promise<void> {
    if (this.activeExecutions.size > 0) {
      this.logger.info('Draining %d active Claude execution(s)...', this.activeExecutions.size);
      await Promise.allSettled(this.activeExecutions);
    }
  }

  async execute(request: AgentExecutionRequest, sink: AgentExecutionSink): Promise<void> {
    const execution = this.executeInternal(request, sink);
    this.activeExecutions.add(execution);
    try {
      await execution;
    } finally {
      this.activeExecutions.delete(execution);
    }
  }

  private async executeInternal(
    request: AgentExecutionRequest,
    sink: AgentExecutionSink,
  ): Promise<void> {
    const probeExecutionId = request.executionId ?? 'unknown';
    this.logger.info(
      'Claude Agent SDK execution requested (execution=%s thread=%s channel=%s user=%s resume=%s cwd=%s)',
      probeExecutionId,
      request.threadTs,
      request.channelId,
      request.userId,
      request.resumeHandle ?? 'none',
      request.workspacePath ?? '(none)',
    );
    await this.recordExecutionProbe({
      executionId: probeExecutionId,
      kind: 'request',
      recordedAt: new Date().toISOString(),
      ...(request.resumeHandle ? { resumeHandle: request.resumeHandle } : {}),
      threadTs: request.threadTs,
      ...(request.workspacePath ? { workspacePath: request.workspacePath } : {}),
    });

    const mcpServer = createAnthropicAgentSdkMcpServer(
      this.logger,
      this.memoryStore,
      this.channelPreferenceStore,
      request,
      sink,
    );
    const { systemPrompt, userPrompt } = createClaudePromptInput(request);

    const modelOverride = request.modelOverride ?? env.CLAUDE_MODEL;

    this.logger.info(
      'Creating Claude SDK query (execution=%s thread=%s model=%s permissionMode=%s resume=%s cwd=%s)',
      probeExecutionId,
      request.threadTs,
      modelOverride ?? 'default',
      this.permissionMode,
      request.resumeHandle ?? 'none',
      request.workspacePath ?? '(none)',
    );

    let session: ReturnType<typeof query>;
    try {
      const toolOptions = this.buildToolOptions(sink);
      session = query({
        prompt: userPrompt,
        options: {
          ...(modelOverride ? { model: modelOverride } : {}),
          agentProgressSummaries: true,
          includeHookEvents: true,
          includePartialMessages: true,
          ...(request.workspacePath ? { cwd: request.workspacePath } : {}),
          systemPrompt,
          mcpServers: {
            'slack-ui': mcpServer,
          },
          permissionMode: this.permissionMode,
          ...(this.permissionMode === 'bypassPermissions'
            ? { allowDangerouslySkipPermissions: true }
            : {}),
          persistSession: true,
          ...toolOptions,
          ...(request.resumeHandle ? { resume: request.resumeHandle } : {}),
        },
      });
      this.logger.info(
        'Claude SDK query created (execution=%s thread=%s)',
        probeExecutionId,
        request.threadTs,
      );
    } catch (error) {
      const message = this.describeUnknownError(error);
      this.logger.error(
        'Failed to create Claude SDK query (execution=%s thread=%s): %s',
        probeExecutionId,
        request.threadTs,
        message,
      );
      throw error;
    }

    let sessionId: string | undefined;
    let sessionCwd: string | undefined;
    let recordedSessionId: string | undefined;
    const runtimeUi = createRuntimeUiStateTracker();
    const handlers: MessageHandlers = {
      getSessionCwd: () => sessionCwd,
      publishUiState: async () => {
        await this.publishRuntimeUiState(request.threadTs, sink, runtimeUi);
      },
      runtimeUi,
      setSessionCwd: (cwd) => {
        sessionCwd = cwd;
      },
      setSessionId: (id) => {
        sessionId = id;
        if (recordedSessionId === id) {
          return;
        }
        recordedSessionId = id;
        void this.recordExecutionProbe({
          executionId: probeExecutionId,
          kind: 'session',
          recordedAt: new Date().toISOString(),
          ...(sessionCwd ? { sessionCwd } : {}),
          sessionId: id,
          threadTs: request.threadTs,
        });
      },
      workspaceContext: {
        ...(request.workspaceLabel ? { workspaceLabel: request.workspaceLabel } : {}),
        ...(request.workspacePath ? { workspacePath: request.workspacePath } : {}),
        ...(request.workspaceRepoId ? { workspaceRepoId: request.workspaceRepoId } : {}),
      },
    };

    let iterator: AsyncIterator<SDKMessage> | undefined;
    try {
      await sink.onEvent({ type: 'lifecycle', phase: 'started' });
      await this.recordExecutionProbe({
        executionId: probeExecutionId,
        kind: 'lifecycle',
        phase: 'started',
        recordedAt: new Date().toISOString(),
        threadTs: request.threadTs,
      });

      let firstMessage = true;
      this.logger.info(
        'Waiting for Claude SDK output (execution=%s thread=%s)...',
        probeExecutionId,
        request.threadTs,
      );

      iterator = (session as AsyncIterable<SDKMessage>)[Symbol.asyncIterator]();
      for (;;) {
        const next = await nextMessageOrAbort(iterator, request.abortSignal);
        if (next.done) {
          break;
        }
        const message = next.value as SDKMessage;
        if (firstMessage) {
          firstMessage = false;
          this.logger.info(
            'First Claude SDK message (execution=%s thread=%s type=%s)',
            probeExecutionId,
            request.threadTs,
            message.type,
          );
        }

        await handleClaudeSdkMessage(this.logger, message, sink, handlers);
      }

      this.logger.info(
        'Claude SDK message stream ended (execution=%s thread=%s)',
        probeExecutionId,
        request.threadTs,
      );

      await sink.onEvent({
        type: 'lifecycle',
        phase: 'completed',
        ...(sessionId ? { resumeHandle: sessionId } : {}),
      });
      await this.recordExecutionProbe({
        executionId: probeExecutionId,
        kind: 'lifecycle',
        phase: 'completed',
        recordedAt: new Date().toISOString(),
        ...(sessionId ? { resumeHandle: sessionId } : {}),
        threadTs: request.threadTs,
      });
    } catch (error) {
      if (isAbortError(error)) {
        const stopReason =
          request.abortSignal?.reason === 'superseded' ? 'superseded' : 'user_stop';
        this.logger.info(
          'Claude Agent SDK execution stopped (execution=%s reason=%s thread=%s)',
          probeExecutionId,
          stopReason,
          request.threadTs,
        );
        await interruptQuery(session, this.logger, request.threadTs, probeExecutionId);
        await disposeAsyncIterator(iterator, {
          executionId: probeExecutionId,
          logger: this.logger,
          threadTs: request.threadTs,
        });
        try {
          await sink.onEvent({
            type: 'lifecycle',
            phase: 'stopped',
            reason: stopReason,
            ...(sessionId ? { resumeHandle: sessionId } : {}),
          });
          await this.recordExecutionProbe({
            executionId: probeExecutionId,
            kind: 'lifecycle',
            phase: 'stopped',
            reason: stopReason,
            recordedAt: new Date().toISOString(),
            ...(sessionId ? { resumeHandle: sessionId } : {}),
            threadTs: request.threadTs,
          });
        } catch (publishError) {
          const msg = this.describeUnknownError(publishError);
          this.logger.warn(
            'Failed to publish stopped lifecycle (execution=%s thread=%s): %s',
            probeExecutionId,
            request.threadTs,
            redact(msg),
          );
        }
        return;
      }
      const errorMessage = this.describeUnknownError(error);
      this.logger.error(
        'Claude Agent SDK execution failed (execution=%s thread=%s): %s',
        probeExecutionId,
        request.threadTs,
        redact(errorMessage),
      );
      await sink.onEvent({
        type: 'lifecycle',
        phase: 'failed',
        ...(sessionId ? { resumeHandle: sessionId } : {}),
        error: errorMessage,
      });
      await this.recordExecutionProbe({
        executionId: probeExecutionId,
        kind: 'lifecycle',
        phase: 'failed',
        recordedAt: new Date().toISOString(),
        ...(sessionId ? { resumeHandle: sessionId } : {}),
        threadTs: request.threadTs,
      });
    }
  }

  private async logClaudeAuthStatus(): Promise<void> {
    try {
      const { stdout } = await execFileAsync('claude', ['auth', 'status', '--json'], {
        env: process.env,
        timeout: 5_000,
      });
      const status = JSON.parse(stdout) as ClaudeAuthStatus;
      this.logger.info(
        'Claude Code auth status at executor startup: loggedIn=%s authMethod=%s apiProvider=%s subscriptionType=%s email=%s orgName=%s',
        status.loggedIn === true ? 'true' : 'false',
        status.authMethod ?? '(unknown)',
        status.apiProvider ?? '(unknown)',
        status.subscriptionType ?? '(unknown)',
        status.email ?? '(unknown)',
        status.orgName ?? '(unknown)',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('Failed to query Claude Code auth status at executor startup: %s', message);
    }
  }

  private logClaudeRuntimeConfig(): void {
    const config = getClaudeRuntimeConfigSummary();
    this.logger.info(
      'Claude Code runtime config at executor startup: CLAUDE_MODEL=%s ANTHROPIC_MODEL=%s ANTHROPIC_DEFAULT_SONNET_MODEL=%s ANTHROPIC_DEFAULT_HAIKU_MODEL=%s ANTHROPIC_DEFAULT_OPUS_MODEL=%s ANTHROPIC_BASE_URL=%s',
      config.claudeModel ?? '(unset)',
      config.anthropicModel ?? '(unset)',
      config.anthropicDefaultSonnetModel ?? '(unset)',
      config.anthropicDefaultHaikuModel ?? '(unset)',
      config.anthropicDefaultOpusModel ?? '(unset)',
      config.anthropicBaseUrl ?? '(unset)',
    );
  }

  private describeUnknownError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async recordExecutionProbe(record: ClaudeExecutionProbeRecord): Promise<void> {
    if (!this.executionProbe) {
      return;
    }
    try {
      await this.executionProbe.record(record);
    } catch (error) {
      this.logger.warn(
        'Failed to record Claude execution probe for thread %s: %s',
        record.threadTs,
        this.describeUnknownError(error),
      );
    }
  }

  private buildToolOptions(sink: AgentExecutionSink): {
    allowedTools?: string[];
    canUseTool?: CanUseTool;
    settingSources?: Array<'user' | 'project'>;
  } {
    const skillsEnabled = env.CLAUDE_ENABLE_SKILLS;
    const hasPermissionBridge = !!sink.requestPermission;

    if (!skillsEnabled && !hasPermissionBridge) {
      return {};
    }

    return {
      ...(skillsEnabled
        ? {
            settingSources: ['user', 'project'] as Array<'user' | 'project'>,
            allowedTools: ['Skill'],
          }
        : {}),
      canUseTool: async (toolName, input, options) => {
        // --- Skill dispatch (always allow when skills enabled) ---
        if (skillsEnabled && toolName === 'Skill') {
          return {
            behavior: 'allow',
            updatedInput: input,
          };
        }

        // AskUserQuestion is intentionally disabled. Agents should ask visibly in
        // Slack with an explicit mention and numbered choices instead.
        if (toolName === 'AskUserQuestion') {
          return {
            behavior: 'deny',
            message:
              'AskUserQuestion is disabled in this Slack host. Ask visibly in the Slack thread, mention the responsible user or agent, present numbered choices if useful, and wait for their reply.',
          };
        }

        // --- bypassPermissions: auto-approve remaining tools ---
        if (this.permissionMode === 'bypassPermissions') {
          return {
            behavior: 'allow',
            updatedInput: input,
          };
        }

        // --- Permission bridge (Approve/Deny buttons in Slack) ---
        if (hasPermissionBridge) {
          const response = await sink.requestPermission!(
            {
              toolName,
              input,
              description: options.description,
            },
            { signal: options.signal },
          );

          if (response.allowed) {
            return {
              behavior: 'allow',
              updatedInput: input,
            };
          }

          return {
            behavior: 'deny',
            message: `用户在 Slack 中拒绝了 ${toolName} 工具的使用请求。`,
          };
        }

        // --- No bridge available: deny ---
        return {
          behavior: 'deny',
          message:
            'The Slack host does not support interactive permission requests for this tool right now.',
        };
      },
    };
  }

  private get permissionMode(): typeof env.CLAUDE_PERMISSION_MODE {
    return this.options?.permissionMode ?? env.CLAUDE_PERMISSION_MODE;
  }

  private async publishRuntimeUiState(
    threadTs: string,
    sink: AgentExecutionSink,
    runtimeUi: RuntimeUiStateTracker,
  ): Promise<void> {
    const state = buildRuntimeUiState(threadTs, runtimeUi);
    if (!state) {
      return;
    }

    await sink.onEvent({
      type: 'activity-state',
      state,
    });
  }
}
