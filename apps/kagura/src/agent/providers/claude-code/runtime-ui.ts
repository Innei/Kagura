import path from 'node:path';

import type { SDKPartialAssistantMessage } from '@anthropic-ai/claude-agent-sdk';

import type { AgentActivityState } from '~/agent/types.js';
import {
  DEFAULT_ASSISTANT_THINKING_STATUS,
  getShuffledThinkingMessages,
} from '~/slack/thinking-messages.js';

import { RECALL_MEMORY_TOOL_NAME } from './tools/recall-memory.js';
import { SAVE_MEMORY_TOOL_NAME } from './tools/save-memory.js';
import { UPLOAD_SLACK_FILE_TOOL_NAME } from './tools/upload-slack-file.js';
import type { RuntimeSystemStatusKey, RuntimeUiStateTracker } from './types.js';

type StreamToolStartEvent = {
  type: 'content_block_start';
  index: number;
  content_block: {
    type: string;
    name?: string;
  };
};

type StreamToolDeltaEvent = {
  type: 'content_block_delta';
  index: number;
  delta: {
    type: string;
    partial_json?: string;
    text?: string;
  };
};

export function extractStreamTextDelta(message: SDKPartialAssistantMessage): string | undefined {
  const event = message.event as StreamToolDeltaEvent;
  if (event.type !== 'content_block_delta' || event.delta.type !== 'text_delta') {
    return undefined;
  }
  return event.delta.text || undefined;
}

type StreamToolStopEvent = {
  type: 'content_block_stop';
  index: number;
};

export function createRuntimeUiStateTracker(): RuntimeUiStateTracker {
  return {
    loadingMessages: [],
    sessionStatus: DEFAULT_ASSISTANT_THINKING_STATUS,
    systemStatuses: {},
    taskStatus: undefined,
    textStreamingActive: false,
    toolStatus: undefined,
    activeStreamToolUses: new Map(),
  };
}

export function buildRuntimeUiState(
  threadTs: string,
  runtimeUi: RuntimeUiStateTracker,
): AgentActivityState | undefined {
  const status = pickRuntimeStatus(runtimeUi);
  const loadingMessages = buildRuntimeLoadingMessages(runtimeUi, status);

  if (!status && loadingMessages.length === 0) {
    return undefined;
  }

  const composing = runtimeUi.textStreamingActive && runtimeUi.activeStreamToolUses.size === 0;

  return {
    threadTs,
    ...(status ? { status } : {}),
    ...(loadingMessages.length > 0 ? { activities: loadingMessages } : {}),
    ...(composing ? { composing: true } : {}),
    clear: false,
  };
}

export function summarizeProgressOutput(text: string): string {
  return normalizeText(text, 240);
}

export function setSessionStatus(runtimeUi: RuntimeUiStateTracker, status: string): void {
  runtimeUi.sessionStatus = normalizeUiStatus(status);
}

export function clearSessionStatus(runtimeUi: RuntimeUiStateTracker): void {
  runtimeUi.sessionStatus = undefined;
}

export function setSystemStatus(
  runtimeUi: RuntimeUiStateTracker,
  key: RuntimeSystemStatusKey,
  status: string,
): void {
  runtimeUi.systemStatuses[key] = normalizeUiStatus(status);
}

export function clearSystemStatus(
  runtimeUi: RuntimeUiStateTracker,
  key: RuntimeSystemStatusKey,
): void {
  delete runtimeUi.systemStatuses[key];
}

export function setTaskStatus(
  runtimeUi: RuntimeUiStateTracker,
  status: string,
  taskId?: string,
): void {
  runtimeUi.taskStatus = {
    text: normalizeUiStatus(status),
    ...(taskId ? { taskId } : {}),
  };
}

export function clearTaskStatus(runtimeUi: RuntimeUiStateTracker, taskId?: string): void {
  if (!runtimeUi.taskStatus) {
    return;
  }

  if (!taskId || runtimeUi.taskStatus.taskId === taskId) {
    runtimeUi.taskStatus = undefined;
  }
}

export function setToolStatus(
  runtimeUi: RuntimeUiStateTracker,
  status: string,
  toolName?: string,
): void {
  runtimeUi.toolStatus = {
    text: normalizeUiStatus(status),
    ...(toolName ? { toolName } : {}),
  };
}

export function clearToolStatus(runtimeUi: RuntimeUiStateTracker, toolName?: string): void {
  if (!runtimeUi.toolStatus) {
    return;
  }

  if (!toolName || runtimeUi.toolStatus.toolName === toolName) {
    runtimeUi.toolStatus = undefined;
  }
}

export function clearTransientSystemStatuses(runtimeUi: RuntimeUiStateTracker): void {
  clearSystemStatus(runtimeUi, 'hook');
  clearSystemStatus(runtimeUi, 'retry');
}

export function rememberLoadingMessage(runtimeUi: RuntimeUiStateTracker, message: string): void {
  const normalized = normalizeLoadingMessage(message);
  if (!normalized) {
    return;
  }

  runtimeUi.loadingMessages = [
    normalized,
    ...runtimeUi.loadingMessages.filter((existing) => existing !== normalized),
  ].slice(0, 10);
}

export function applyStreamEventToUiState(
  runtimeUi: RuntimeUiStateTracker,
  message: SDKPartialAssistantMessage,
): boolean {
  const event = message.event as StreamToolStartEvent | StreamToolDeltaEvent | StreamToolStopEvent;

  if (
    event.type === 'content_block_start' &&
    (event.content_block as { type: string }).type === 'text'
  ) {
    if (!runtimeUi.textStreamingActive) {
      runtimeUi.textStreamingActive = true;
      return true;
    }

    return false;
  }

  if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
    runtimeUi.textStreamingActive = false;
    runtimeUi.activeStreamToolUses.set(event.index, {
      toolName: event.content_block.name ?? 'tool',
      partialInput: '',
      updatedAt: Date.now(),
    });
    return true;
  }

  if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
    const activeToolUse = runtimeUi.activeStreamToolUses.get(event.index);
    if (!activeToolUse) {
      return false;
    }

    activeToolUse.partialInput += event.delta.partial_json ?? '';
    activeToolUse.updatedAt = Date.now();
    return true;
  }

  if (event.type === 'content_block_stop') {
    const activeToolUse = runtimeUi.activeStreamToolUses.get(event.index);
    if (!activeToolUse) {
      return false;
    }

    runtimeUi.activeStreamToolUses.delete(event.index);
    clearToolStatus(runtimeUi, activeToolUse.toolName);
    return true;
  }

  return false;
}

export function describeGenericToolActivity(toolName: string): string {
  return describeStreamToolUse(toolName, '');
}

function pickRuntimeStatus(runtimeUi: RuntimeUiStateTracker): string {
  return normalizeUiStatus(
    runtimeUi.toolStatus?.text ??
      runtimeUi.taskStatus?.text ??
      pickRuntimeSystemStatus(runtimeUi) ??
      runtimeUi.sessionStatus ??
      DEFAULT_ASSISTANT_THINKING_STATUS,
  );
}

function pickRuntimeSystemStatus(runtimeUi: RuntimeUiStateTracker): string | undefined {
  return (
    runtimeUi.systemStatuses.permission ??
    runtimeUi.systemStatuses.auth ??
    runtimeUi.systemStatuses.compacting ??
    runtimeUi.systemStatuses.retry ??
    runtimeUi.systemStatuses.hook
  );
}

function buildRuntimeLoadingMessages(runtimeUi: RuntimeUiStateTracker, status: string): string[] {
  const streamToolMessages = [...runtimeUi.activeStreamToolUses.values()]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map((toolUse) => describeStreamToolUse(toolUse.toolName, toolUse.partialInput))
    .filter(Boolean);

  const merged = [...streamToolMessages, ...runtimeUi.loadingMessages];
  const normalized = merged.map((message) => normalizeLoadingMessage(message)).filter(Boolean);
  const deduped = [...new Set(normalized)].slice(0, 10);

  if (deduped.length > 0) {
    return deduped;
  }

  // Generic thinking: emit the shared carousel pool instead of echoing a
  // single line equal to `status`. Slack renders these as the rotating
  // loading_messages list inside the assistant-thread container.
  if (status === DEFAULT_ASSISTANT_THINKING_STATUS) {
    return getShuffledThinkingMessages();
  }

  return status ? [normalizeLoadingMessage(status)] : [];
}

function describeStreamToolUse(toolName: string, partialInput: string): string {
  const normalizedName = toolName.toLowerCase();

  switch (normalizedName) {
    case 'readfile': {
      const targetPath = extractToolInputValue(partialInput, ['path']);
      return targetPath ? `Reading ${formatUiPath(targetPath)}...` : 'Reading a file...';
    }

    case 'glob': {
      const pattern = extractToolInputValue(partialInput, ['glob_pattern']);
      return pattern ? `Finding files matching ${pattern}...` : 'Finding matching files...';
    }

    case 'rg': {
      const pattern = extractToolInputValue(partialInput, ['pattern']);
      return pattern ? `Searching for ${pattern}...` : 'Searching the workspace...';
    }

    case 'semanticsearch': {
      const queryText = extractToolInputValue(partialInput, ['query']);
      return queryText ? `Searching code for ${queryText}...` : 'Exploring relevant code...';
    }

    case 'webfetch': {
      const url = extractToolInputValue(partialInput, ['url']);
      return url ? `Fetching ${formatUrlForUi(url)}...` : 'Fetching a webpage...';
    }

    case 'shell': {
      const description = extractToolInputValue(partialInput, ['description']);
      if (description) {
        return `Running ${description}...`;
      }

      const command = extractToolInputValue(partialInput, ['command']);
      if (command) {
        return `Running ${formatCommandForUi(command)}...`;
      }

      return 'Running a shell command...';
    }

    case 'callmcptool': {
      const server = extractToolInputValue(partialInput, ['server']);
      const mcpToolName = extractToolInputValue(partialInput, ['toolName', 'tool_name']);
      if (server && mcpToolName) {
        return `Calling ${mcpToolName} on ${server}...`;
      }

      return 'Calling an MCP tool...';
    }

    case RECALL_MEMORY_TOOL_NAME: {
      return 'Recalling workspace memories...';
    }

    case SAVE_MEMORY_TOOL_NAME: {
      return 'Saving workspace memory...';
    }

    case UPLOAD_SLACK_FILE_TOOL_NAME: {
      const targetPath = extractToolInputValue(partialInput, ['path']);
      return targetPath
        ? `Queueing ${formatUiPath(targetPath)} for Slack upload...`
        : 'Queueing a file for Slack upload...';
    }

    case 'readlints': {
      return 'Checking linter diagnostics...';
    }

    case 'applypatch': {
      return 'Applying code changes...';
    }

    case 'editnotebook': {
      return 'Editing a notebook...';
    }

    case 'askquestion': {
      return 'Waiting for user input...';
    }

    case 'generateimage': {
      return 'Generating an image...';
    }

    case 'multi_tool_use.parallel': {
      return 'Running parallel tool calls...';
    }

    default: {
      return `Using ${toolName}...`;
    }
  }
}

function extractToolInputValue(partialInput: string, keys: string[]): string | undefined {
  const parsedInput = tryParseToolInput(partialInput);
  for (const key of keys) {
    const parsedValue = parsedInput?.[key];
    if (typeof parsedValue === 'string' && parsedValue.trim()) {
      return parsedValue.trim();
    }
  }

  for (const key of keys) {
    const pattern = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"([^"]*)`);
    const match = partialInput.match(pattern);
    if (match?.[1]) {
      return unescapeJsonFragment(match[1]).trim();
    }
  }

  return undefined;
}

function tryParseToolInput(partialInput: string): Record<string, unknown> | undefined {
  const trimmed = partialInput.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function formatUiPath(targetPath: string): string {
  const normalized = targetPath.replaceAll('\\', '/').trim();
  if (!normalized) {
    return 'file';
  }

  const basename = path.posix.basename(normalized);
  const parent = path.posix.basename(path.posix.dirname(normalized));
  if (!parent || parent === '.' || parent === '/' || parent === basename) {
    return basename;
  }

  return `${parent}/${basename}`;
}

function formatUrlForUi(value: string): string {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return value;
  }
}

function formatCommandForUi(command: string): string {
  const normalized = normalizeText(command, 80);
  if (!normalized) {
    return 'shell command';
  }

  return normalized;
}

function unescapeJsonFragment(value: string): string {
  return value.replaceAll('\\"', '"').replaceAll('\\\\', '\\').replaceAll('\\/', '/');
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[$()*+.?[\\\]^{|}]/g, '\\$&');
}

function normalizeUiStatus(text: string): string {
  return normalizeText(text, 120);
}

function normalizeLoadingMessage(text: string): string {
  return normalizeText(text, 240);
}

function normalizeText(text: string, maxLength: number): string {
  const normalized = text.trim().replaceAll(/\s+/g, ' ');
  if (!normalized) {
    return '';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}
