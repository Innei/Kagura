import path from 'node:path';

import type {
  SDKAPIRetryMessage,
  SDKAssistantMessage,
  SDKAuthStatusMessage,
  SDKFilesPersistedEvent,
  SDKHookProgressMessage,
  SDKLocalCommandOutputMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSessionStateChangedMessage,
  SDKStatusMessage,
  SDKSystemMessage,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKTaskStartedMessage,
  SDKToolProgressMessage,
} from '@anthropic-ai/claude-agent-sdk';

import type { GeneratedOutputFile, ModelUsageInfo, SessionUsageInfo } from '~/agent/types.js';
import {
  detectWorkspaceContextFromPath,
  detectWorkspaceContextFromText,
} from '~/agent/workspace-context.js';
import type { AppLogger } from '~/logger/index.js';
import { redact } from '~/logger/redact.js';
import { DEFAULT_ASSISTANT_THINKING_STATUS } from '~/slack/thinking-messages.js';

import {
  applyStreamEventToUiState,
  clearSessionStatus,
  clearSystemStatus,
  clearTaskStatus,
  clearToolStatus,
  clearTransientSystemStatuses,
  describeGenericToolActivity,
  rememberLoadingMessage,
  setSessionStatus,
  setSystemStatus,
  setTaskStatus,
  setToolStatus,
  summarizeProgressOutput,
} from './runtime-ui.js';
import type { AgentExecutionSink, MessageHandlers } from './types.js';

export async function handleClaudeSdkMessage(
  logger: AppLogger,
  message: SDKMessage,
  sink: AgentExecutionSink,
  handlers: MessageHandlers,
): Promise<void> {
  switch (message.type) {
    case 'system': {
      await handleSystemMessage(
        logger,
        message as SDKMessage & { subtype: string },
        sink,
        handlers,
      );
      break;
    }

    case 'assistant': {
      await handleAssistantMessage(logger, message as SDKAssistantMessage, sink, handlers);
      break;
    }

    case 'auth_status': {
      await handleAuthStatusMessage(logger, message as SDKAuthStatusMessage, handlers);
      break;
    }

    case 'tool_progress': {
      await handleToolProgressMessage(logger, message as SDKToolProgressMessage, sink, handlers);
      break;
    }

    case 'stream_event': {
      const stream = message as SDKPartialAssistantMessage;
      if (applyStreamEventToUiState(handlers.runtimeUi, stream)) {
        await handlers.publishUiState();
      }
      break;
    }

    case 'result': {
      clearToolStatus(handlers.runtimeUi);
      clearSystemStatus(handlers.runtimeUi, 'hook');
      clearSystemStatus(handlers.runtimeUi, 'retry');
      clearSystemStatus(handlers.runtimeUi, 'compacting');
      await handleResult(logger, message as SDKResultMessage, sink);
      break;
    }

    default: {
      const record = message as { type?: string };
      logger.info('Unhandled Claude SDK message type: %s', record.type ?? 'unknown');
    }
  }
}

async function handleSystemMessage(
  logger: AppLogger,
  message: SDKMessage & { subtype: string },
  sink: AgentExecutionSink,
  handlers: MessageHandlers,
): Promise<void> {
  switch (message.subtype) {
    case 'init': {
      await handleSystemInit(logger, message as SDKSystemMessage, sink, handlers);
      return;
    }

    case 'local_command_output': {
      await handleLocalCommandOutputMessage(
        message as SDKLocalCommandOutputMessage,
        sink,
        handlers,
      );
      return;
    }

    case 'api_retry': {
      await handleApiRetryMessage(logger, message as SDKAPIRetryMessage, handlers);
      return;
    }

    case 'task_started': {
      await handleTaskStartedMessage(message as SDKTaskStartedMessage, sink, handlers);
      return;
    }

    case 'task_progress': {
      await handleTaskProgressMessage(message as SDKTaskProgressMessage, sink, handlers);
      return;
    }

    case 'task_notification': {
      await handleTaskNotificationMessage(message as SDKTaskNotificationMessage, sink, handlers);
      return;
    }

    case 'status': {
      await handleStatusMessage(logger, message as SDKStatusMessage, handlers);
      return;
    }

    case 'session_state_changed': {
      await handleSessionStateChangedMessage(
        logger,
        message as SDKSessionStateChangedMessage,
        handlers,
      );
      return;
    }

    case 'hook_progress': {
      await handleHookProgressMessage(logger, message as SDKHookProgressMessage, sink, handlers);
      return;
    }

    case 'files_persisted': {
      await handleFilesPersistedMessage(message as SDKFilesPersistedEvent, sink, handlers);
      return;
    }

    default: {
      logger.info('Unhandled Claude system message subtype: %s', message.subtype);
    }
  }
}

const PERSISTED_IMAGE_FILENAME = /\.(?:gif|jpe?g|png|webp)$/i;

function isPersistedImageFilename(filename: string): boolean {
  return PERSISTED_IMAGE_FILENAME.test(path.basename(filename));
}

async function handleFilesPersistedMessage(
  message: SDKFilesPersistedEvent,
  sink: AgentExecutionSink,
  handlers: MessageHandlers,
): Promise<void> {
  const baseDir = handlers.getSessionCwd() ?? process.cwd();
  const imageFiles: GeneratedOutputFile[] = [];
  const otherFiles: GeneratedOutputFile[] = [];
  for (const entry of message.files) {
    const file: GeneratedOutputFile = {
      fileName: entry.filename,
      path: path.resolve(baseDir, entry.filename),
      providerFileId: entry.file_id,
    };

    if (isPersistedImageFilename(entry.filename)) {
      imageFiles.push(file);
    } else {
      otherFiles.push(file);
    }
  }

  if (imageFiles.length > 0) {
    await sink.onEvent({ type: 'generated-images', files: imageFiles });
  }
  if (otherFiles.length > 0) {
    await sink.onEvent({ type: 'generated-files', files: otherFiles });
  }
}

async function handleSystemInit(
  logger: AppLogger,
  message: SDKSystemMessage,
  sink: AgentExecutionSink,
  handlers: MessageHandlers,
): Promise<void> {
  handlers.setSessionId(message.session_id);
  handlers.setSessionCwd(message.cwd);
  await maybeEmitWorkspaceContextFromPath(message.cwd, sink, handlers);
  logger.info(
    'Claude Code effective session model resolved: id=%s model=%s cwd=%s',
    message.session_id,
    message.model,
    message.cwd,
  );
}

async function handleLocalCommandOutputMessage(
  message: SDKLocalCommandOutputMessage,
  sink: AgentExecutionSink,
  handlers: MessageHandlers,
): Promise<void> {
  await maybeEmitWorkspaceContextFromText(message.content, sink, handlers);
}

async function handleApiRetryMessage(
  logger: AppLogger,
  message: SDKAPIRetryMessage,
  handlers: MessageHandlers,
): Promise<void> {
  const retryStatus = formatApiRetryStatus(message);
  logger.warn(
    'Claude API retry %d/%d after %dms (http=%s error=%s)',
    message.attempt,
    message.max_retries,
    message.retry_delay_ms,
    message.error_status === null ? 'none' : String(message.error_status),
    message.error,
  );
  setSystemStatus(handlers.runtimeUi, 'retry', retryStatus);
  rememberLoadingMessage(handlers.runtimeUi, retryStatus);
  await handlers.publishUiState();
}

function formatApiRetryStatus(message: SDKAPIRetryMessage): string {
  const details = [
    `attempt ${message.attempt}/${message.max_retries}`,
    message.error_status === null ? 'network/no HTTP response' : `HTTP ${message.error_status}`,
    message.error,
  ];

  return `Retrying Claude API request (${details.join(', ')})...`;
}

async function handleTaskStartedMessage(
  message: SDKTaskStartedMessage,
  sink: AgentExecutionSink,
  handlers: MessageHandlers,
): Promise<void> {
  await sink.onEvent({
    type: 'task-update',
    taskId: message.task_id,
    title: message.description,
    status: 'in_progress',
  });
  clearTransientSystemStatuses(handlers.runtimeUi);
  setTaskStatus(handlers.runtimeUi, message.description, message.task_id);
  rememberLoadingMessage(handlers.runtimeUi, message.description);
  await handlers.publishUiState();
}

async function handleTaskProgressMessage(
  message: SDKTaskProgressMessage,
  sink: AgentExecutionSink,
  handlers: MessageHandlers,
): Promise<void> {
  await sink.onEvent({
    type: 'task-update',
    taskId: message.task_id,
    title: message.description,
    status: 'in_progress',
    ...(message.summary ? { details: message.summary } : {}),
  });
  clearTransientSystemStatuses(handlers.runtimeUi);
  const taskStatusText = message.last_tool_name
    ? `Running ${message.last_tool_name}...`
    : message.description;
  setTaskStatus(handlers.runtimeUi, taskStatusText, message.task_id);
  rememberLoadingMessage(handlers.runtimeUi, message.summary ?? message.description);
  await handlers.publishUiState();
}

async function handleTaskNotificationMessage(
  message: SDKTaskNotificationMessage,
  sink: AgentExecutionSink,
  handlers: MessageHandlers,
): Promise<void> {
  const status = message.status === 'completed' ? ('complete' as const) : ('error' as const);
  await sink.onEvent({
    type: 'task-update',
    taskId: message.task_id,
    title: message.summary,
    status,
    ...(message.output_file ? { output: message.output_file } : {}),
  });
  await maybeEmitWorkspaceContextFromText(
    [message.output_file, message.summary].filter(Boolean).join('\n'),
    sink,
    handlers,
  );
  clearTaskStatus(handlers.runtimeUi, message.task_id);
  clearToolStatus(handlers.runtimeUi);
  await handlers.publishUiState();
}

async function handleStatusMessage(
  logger: AppLogger,
  message: SDKStatusMessage,
  handlers: MessageHandlers,
): Promise<void> {
  logger.info(
    'Claude session status update: status=%s permissionMode=%s',
    message.status ?? 'idle',
    message.permissionMode ?? 'unknown',
  );
  if (message.status === 'compacting') {
    setSystemStatus(handlers.runtimeUi, 'compacting', 'Compacting conversation context...');
    rememberLoadingMessage(handlers.runtimeUi, 'Compacting conversation context...');
  } else {
    clearSystemStatus(handlers.runtimeUi, 'compacting');
  }
  await handlers.publishUiState();
}

async function handleSessionStateChangedMessage(
  logger: AppLogger,
  message: SDKSessionStateChangedMessage,
  handlers: MessageHandlers,
): Promise<void> {
  logger.info('Claude session state changed: %s', message.state);
  if (message.state === 'running') {
    setSessionStatus(handlers.runtimeUi, DEFAULT_ASSISTANT_THINKING_STATUS);
    clearSystemStatus(handlers.runtimeUi, 'permission');
  } else if (message.state === 'requires_action') {
    setSystemStatus(handlers.runtimeUi, 'permission', 'Awaiting permission...');
    rememberLoadingMessage(handlers.runtimeUi, 'Waiting for permission approval...');
  } else {
    clearSystemStatus(handlers.runtimeUi, 'permission');
    clearSessionStatus(handlers.runtimeUi);
  }
  await handlers.publishUiState();
}

async function handleHookProgressMessage(
  logger: AppLogger,
  message: SDKHookProgressMessage,
  sink: AgentExecutionSink,
  handlers: MessageHandlers,
): Promise<void> {
  const output = summarizeProgressOutput(message.output || message.stderr || message.stdout);
  logger.info(
    'Claude hook progress: %s (%s)%s',
    message.hook_name,
    message.hook_event,
    output ? ` - ${redact(output)}` : '',
  );
  const hookStatus = `Running ${message.hook_name} hook...`;
  setSystemStatus(handlers.runtimeUi, 'hook', hookStatus);
  rememberLoadingMessage(handlers.runtimeUi, output || hookStatus);
  await maybeEmitWorkspaceContextFromText(output, sink, handlers);
  await handlers.publishUiState();
}

async function handleAssistantMessage(
  logger: AppLogger,
  message: SDKAssistantMessage,
  sink: AgentExecutionSink,
  handlers: MessageHandlers,
): Promise<void> {
  if (message.error) {
    logger.warn('Assistant message reported error=%s', message.error);
  }

  const completedText = extractAssistantText(message);
  if (!completedText) {
    return;
  }

  logger.info(
    'Assistant message completed; emitting Slack reply payload (%d chars)',
    completedText.length,
  );
  await maybeEmitWorkspaceContextFromText(completedText, sink, handlers);
  await sink.onEvent({ type: 'assistant-message', text: completedText });
}

async function handleAuthStatusMessage(
  logger: AppLogger,
  message: SDKAuthStatusMessage,
  handlers: MessageHandlers,
): Promise<void> {
  const output = message.output.join('\n').trim();
  if (message.error) {
    logger.error('Claude auth status error: %s', redact(message.error));
  } else {
    logger.info('Claude auth status: authenticating=%s', String(message.isAuthenticating));
    if (message.isAuthenticating) {
      setSystemStatus(handlers.runtimeUi, 'auth', 'Authenticating Claude...');
      rememberLoadingMessage(handlers.runtimeUi, 'Authenticating Claude...');
    } else {
      clearSystemStatus(handlers.runtimeUi, 'auth');
    }
  }

  if (output) {
    logger.info('Claude auth status output: %s', redact(output));
    rememberLoadingMessage(handlers.runtimeUi, output);
  }

  await handlers.publishUiState();
}

async function maybeEmitWorkspaceContextFromPath(
  workspacePath: string,
  sink: AgentExecutionSink,
  handlers: MessageHandlers,
): Promise<void> {
  const workspaceContext = detectWorkspaceContextFromPath(workspacePath, {
    originalWorkspaceLabel: handlers.workspaceContext?.workspaceLabel,
    originalWorkspacePath: handlers.workspaceContext?.workspacePath,
    workspaceRepoId: handlers.workspaceContext?.workspaceRepoId,
  });
  if (!workspaceContext) {
    return;
  }

  await sink.onEvent({
    type: 'workspace-context',
    ...workspaceContext,
  });
}

async function maybeEmitWorkspaceContextFromText(
  text: string,
  sink: AgentExecutionSink,
  handlers: MessageHandlers,
): Promise<void> {
  if (!text.trim()) {
    return;
  }

  const workspaceContext = detectWorkspaceContextFromText(text, {
    originalWorkspaceLabel: handlers.workspaceContext?.workspaceLabel,
    originalWorkspacePath: handlers.workspaceContext?.workspacePath,
    workspaceRepoId: handlers.workspaceContext?.workspaceRepoId,
  });
  if (!workspaceContext) {
    return;
  }

  await sink.onEvent({
    type: 'workspace-context',
    ...workspaceContext,
  });
}

async function handleToolProgressMessage(
  logger: AppLogger,
  message: SDKToolProgressMessage,
  sink: AgentExecutionSink,
  handlers: MessageHandlers,
): Promise<void> {
  const elapsed = message.elapsed_time_seconds.toFixed(1);
  logger.info('Claude tool progress: %s (%ss elapsed)', message.tool_name, elapsed);
  await sink.onEvent({
    type: 'task-update',
    taskId: message.task_id ?? message.tool_use_id,
    title: `Running ${message.tool_name}`,
    status: 'in_progress',
    details: `Elapsed ${elapsed}s`,
  });
  clearTransientSystemStatuses(handlers.runtimeUi);
  setToolStatus(
    handlers.runtimeUi,
    `Running ${message.tool_name} (${elapsed}s)...`,
    message.tool_name,
  );
  rememberLoadingMessage(handlers.runtimeUi, describeGenericToolActivity(message.tool_name));
  await handlers.publishUiState();
}

async function handleResult(
  logger: AppLogger,
  message: SDKResultMessage,
  sink: AgentExecutionSink,
): Promise<void> {
  if (message.subtype === 'success') {
    logger.info(
      'Claude execution completed in %dms, cost $%s',
      message.duration_ms,
      message.total_cost_usd.toFixed(4),
    );
  } else {
    logger.warn('Claude execution ended with %s: %s', message.subtype, message.errors.join('; '));
  }

  logModelUsage(logger, message);

  const usageInfo = buildUsageInfo(message);
  if (usageInfo) {
    await sink.onEvent({ type: 'usage-info', usage: usageInfo });
  }
}

function logModelUsage(logger: AppLogger, message: SDKResultMessage): void {
  if (!message.modelUsage) return;
  for (const [model, usage] of Object.entries(message.modelUsage)) {
    const cacheRead = usage.cacheReadInputTokens;
    const cacheCreate = usage.cacheCreationInputTokens;
    const totalInput = usage.inputTokens;
    const cacheHitRate =
      totalInput + cacheRead > 0
        ? ((cacheRead / (totalInput + cacheRead)) * 100).toFixed(1)
        : '0.0';

    logger.info(
      'Token usage [%s]: input=%d output=%d cache_read=%d cache_create=%d cache_hit=%s%% cost=$%s',
      model,
      totalInput,
      usage.outputTokens,
      cacheRead,
      cacheCreate,
      cacheHitRate,
      usage.costUSD.toFixed(4),
    );
  }
}

function buildUsageInfo(message: SDKResultMessage): SessionUsageInfo | undefined {
  if (!message.modelUsage) return undefined;

  const modelUsage: ModelUsageInfo[] = [];

  for (const [model, usage] of Object.entries(message.modelUsage)) {
    const cacheRead = usage.cacheReadInputTokens;
    const totalInput = usage.inputTokens;
    const cacheHitRate =
      totalInput + cacheRead > 0 ? (cacheRead / (totalInput + cacheRead)) * 100 : 0;

    modelUsage.push({
      model,
      inputTokens: totalInput,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: cacheRead,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      cacheHitRate,
      costUSD: usage.costUSD,
    });
  }

  return {
    totalCostUSD: message.total_cost_usd,
    durationMs: message.duration_ms,
    modelUsage,
  };
}

function extractAssistantText(message: SDKAssistantMessage): string {
  const content = Array.isArray(message.message.content) ? message.message.content : [];

  return content
    .flatMap((block) => {
      if (block.type === 'text' && typeof block.text === 'string') {
        return [block.text];
      }

      return [];
    })
    .join('');
}
