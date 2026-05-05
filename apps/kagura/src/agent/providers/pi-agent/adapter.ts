import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import type {
  AgentExecutionRequest,
  AgentExecutionSink,
  AgentExecutor,
  GeneratedOutputFile,
  SessionUsageInfo,
} from '~/agent/types.js';
import type { ChannelPreferenceStore } from '~/channel-preference/types.js';
import { env } from '~/env/server.js';
import type { AppLogger } from '~/logger/index.js';
import { redact } from '~/logger/redact.js';

import { parseSetChannelDefaultWorkspaceToolInput } from '../claude-code/tools/set-channel-default-workspace.js';
import { buildPiAgentPrompt, getPiAgentRuntimePaths } from './prompt.js';

const ABORT_KILL_TIMEOUT_MS = 1_000;
const MAX_GENERATED_ARTIFACT_BYTES = 50 * 1024 * 1024;
const GENERATED_IMAGE_FILENAME = /\.(?:gif|jpe?g|png|webp)$/i;
const KAGURA_MEMORY_SHIM_NAME = 'kagura-memory';

interface GeneratedArtifactSnapshotEntry {
  mtimeMs: number;
  path: string;
  size: number;
}

type GeneratedArtifactSnapshot = Map<string, GeneratedArtifactSnapshotEntry>;

interface PiAgentJsonEvent {
  args?: unknown;
  assistantMessageEvent?: PiAssistantMessageEvent | undefined;
  isError?: unknown;
  message?: PiAgentMessage | undefined;
  messages?: PiAgentMessage[] | undefined;
  result?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  toolResults?: PiAgentMessage[] | undefined;
  type: string;
}

interface PiAssistantMessageEvent {
  content?: unknown;
  contentIndex?: unknown;
  delta?: unknown;
  partial?: PiAgentMessage | undefined;
  toolCall?: PiToolCall | undefined;
  type?: unknown;
}

interface PiAgentMessage {
  api?: unknown;
  content?: PiMessageContent[] | undefined;
  isError?: unknown;
  model?: unknown;
  provider?: unknown;
  role?: unknown;
  stopReason?: unknown;
  timestamp?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  usage?: PiUsage | undefined;
}

interface PiMessageContent {
  arguments?: unknown;
  id?: unknown;
  name?: unknown;
  text?: unknown;
  thinking?: unknown;
  type?: unknown;
}

interface PiToolCall {
  arguments?: unknown;
  id?: unknown;
  name?: unknown;
  type?: unknown;
}

interface PiUsage {
  cacheRead?: unknown;
  cacheWrite?: unknown;
  cost?: { total?: unknown } | undefined;
  input?: unknown;
  output?: unknown;
  totalTokens?: unknown;
}

interface PiStreamState {
  completedToolTaskIds: Set<string>;
  fallbackStdoutLines: string[];
  inProgressToolTaskIds: Set<string>;
  jsonEventsSeen: boolean;
  lastAssistantText: string | undefined;
  lastUsage: PiUsage | undefined;
  model: string | undefined;
}

function createAbortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function prependPath(entry: string, current: string | undefined): string {
  return current ? `${entry}${path.delimiter}${current}` : entry;
}

async function writeKaguraMemoryShim(runtimeDir: string): Promise<void> {
  const cliPath = resolveKaguraMemoryCliPath();
  const loaderArgs = cliPath.endsWith('.ts') ? ' --import tsx' : '';
  const shimPath = path.join(runtimeDir, KAGURA_MEMORY_SHIM_NAME);
  const script = [
    '#!/bin/sh',
    `exec ${shellQuote(process.execPath)}${loaderArgs} ${shellQuote(cliPath)} "$@"`,
    '',
  ].join('\n');
  await writeFile(shimPath, script, 'utf8');
  await chmod(shimPath, 0o755);
}

function resolveKaguraMemoryCliPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  if (path.extname(fileURLToPath(import.meta.url)) === '.js') {
    return path.join(here, 'memory-cli.js');
  }
  return path.resolve(here, '../../../memory-cli.ts');
}

export class PiAgentExecutor implements AgentExecutor {
  readonly providerId = 'pi-agent';
  private readonly activeExecutions = new Set<Promise<void>>();

  constructor(
    private readonly logger: AppLogger,
    private readonly channelPreferenceStore?: ChannelPreferenceStore | undefined,
  ) {
    this.logger.info(
      'Pi Agent provider configured: command=%s args=%s model=%s',
      env.PI_AGENT_COMMAND,
      env.PI_AGENT_ARGS,
      env.PI_AGENT_MODEL ?? '(unknown)',
    );
  }

  async drain(): Promise<void> {
    if (this.activeExecutions.size > 0) {
      this.logger.info('Draining %d active Pi Agent execution(s)...', this.activeExecutions.size);
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
    const executionId = request.executionId ?? 'unknown';
    const executionStartedAt = Date.now();
    const runtimePaths = getPiAgentRuntimePaths(request);
    const cwd = request.workspacePath ?? runtimePaths.runtimeDir;
    const prompt = buildPiAgentPrompt(request, runtimePaths);
    const streamState: PiStreamState = {
      completedToolTaskIds: new Set<string>(),
      fallbackStdoutLines: [],
      inProgressToolTaskIds: new Set<string>(),
      jsonEventsSeen: false,
      lastAssistantText: undefined,
      lastUsage: undefined,
      model: undefined,
    };
    const stderrLines: string[] = [];
    let child: ChildProcessWithoutNullStreams | undefined;
    let abortCleanup: (() => void) | undefined;

    this.logger.info(
      'Pi Agent execution requested (execution=%s thread=%s channel=%s user=%s cwd=%s)',
      executionId,
      request.threadTs,
      request.channelId,
      request.userId,
      cwd,
    );

    try {
      await mkdir(runtimePaths.generatedArtifactsDir, { recursive: true });
      await mkdir(runtimePaths.runtimeDir, { recursive: true });
      await writeKaguraMemoryShim(runtimePaths.runtimeDir);
      const generatedArtifactsBefore = await snapshotGeneratedArtifacts(
        runtimePaths.generatedArtifactsDir,
      );
      const args = parsePiAgentArgs(env.PI_AGENT_ARGS);
      child = spawn(env.PI_AGENT_COMMAND, args, {
        cwd,
        env: {
          ...process.env,
          KAGURA_DB_PATH: env.SESSION_DB_PATH,
          PATH: prependPath(runtimePaths.runtimeDir, process.env.PATH),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      abortCleanup = this.attachAbortHandler(child, request.abortSignal);
      await sink.onEvent({ type: 'lifecycle', phase: 'started' });
      await sink.onEvent({
        type: 'activity-state',
        state: {
          status: 'Pi Agent is thinking...',
          threadTs: request.threadTs,
        },
      });

      const stdoutPromise = this.consumeStdout(child, sink, request, streamState);
      const stderrPromise = this.captureStderr(child, executionId, request.threadTs, stderrLines);
      child.stdin.end(prompt);

      const exitPromise = new Promise<void>((resolve, reject) => {
        child!.once('error', reject);
        child!.once('exit', (code, signal) => {
          if (request.abortSignal?.aborted) {
            reject(createAbortError());
            return;
          }
          if (code === 0) {
            resolve();
            return;
          }
          reject(
            new Error(`Pi Agent exited with code ${code ?? 'null'} signal ${signal ?? 'none'}`),
          );
        });
      });

      const settled = await Promise.allSettled([stdoutPromise, stderrPromise, exitPromise]);
      const rejected = settled.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (rejected) {
        throw rejected.reason;
      }

      await this.applyChannelOps(request, runtimePaths.channelOpsPath);
      await publishGeneratedArtifacts(
        sink,
        runtimePaths.generatedArtifactsDir,
        generatedArtifactsBefore,
      );
      const text = streamState.jsonEventsSeen
        ? streamState.lastAssistantText?.trim()
        : streamState.fallbackStdoutLines.join('\n').trim();
      if (text) {
        await sink.onEvent({ type: 'assistant-message', text });
      }
      await sink.onEvent({
        type: 'usage-info',
        usage: this.toUsageInfo(Date.now() - executionStartedAt, streamState),
      });
      await sink.onEvent({
        type: 'activity-state',
        state: { clear: true, threadTs: request.threadTs },
      });
      await sink.onEvent({ type: 'lifecycle', phase: 'completed' });
    } catch (error) {
      if (isAbortError(error)) {
        const reason = request.abortSignal?.reason === 'superseded' ? 'superseded' : 'user_stop';
        this.killChild(child);
        await sink.onEvent({ type: 'lifecycle', phase: 'stopped', reason });
        return;
      }

      const message = formatErrorWithDetails(
        error instanceof Error ? error.message : String(error),
        stderrLines,
      );
      this.logger.error(
        'Pi Agent execution failed (execution=%s thread=%s): %s',
        executionId,
        request.threadTs,
        redact(message),
      );
      await sink.onEvent({
        type: 'activity-state',
        state: { clear: true, threadTs: request.threadTs },
      });
      await sink.onEvent({ type: 'lifecycle', phase: 'failed', error: message });
    } finally {
      abortCleanup?.();
    }
  }

  private async consumeStdout(
    child: ChildProcessWithoutNullStreams,
    sink: AgentExecutionSink,
    request: AgentExecutionRequest,
    state: PiStreamState,
  ): Promise<void> {
    const rl = readline.createInterface({ input: child.stdout });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let event: PiAgentJsonEvent | undefined;
      try {
        event = JSON.parse(trimmed) as PiAgentJsonEvent;
      } catch {
        if (!state.jsonEventsSeen) {
          state.fallbackStdoutLines.push(line);
        } else {
          this.logger.warn(
            'Ignoring non-JSON Pi Agent stdout line in JSON stream: %s',
            redact(line),
          );
        }
        continue;
      }

      if (!event || typeof event.type !== 'string') {
        state.fallbackStdoutLines.push(line);
        continue;
      }

      state.jsonEventsSeen = true;
      await this.handlePiEvent(event, sink, request, state);
    }
  }

  private async handlePiEvent(
    event: PiAgentJsonEvent,
    sink: AgentExecutionSink,
    request: AgentExecutionRequest,
    state: PiStreamState,
  ): Promise<void> {
    switch (event.type) {
      case 'agent_start':
      case 'turn_start': {
        await sink.onEvent({
          type: 'activity-state',
          state: {
            status: 'Pi Agent is thinking...',
            threadTs: request.threadTs,
          },
        });
        return;
      }

      case 'message_update': {
        await this.handlePiMessageUpdate(event, sink, request.threadTs, state);
        return;
      }

      case 'message_end':
      case 'turn_end': {
        updatePiStateFromMessage(state, event.message);
        for (const toolResult of event.toolResults ?? []) {
          await this.handlePiToolResult(toolResult, sink, state);
        }
        return;
      }

      case 'tool_execution_start': {
        const toolName = stringValue(event.toolName) ?? 'tool';
        const taskId = stringValue(event.toolCallId) ?? `pi-tool-${toolName}`;
        const title = describePiToolCall(toolName, event.args);
        await emitPiToolProgress(sink, state, {
          taskId,
          title,
          ...(event.args !== undefined ? { details: stringifyPiDetail(event.args) } : {}),
        });
        await sink.onEvent({
          type: 'activity-state',
          state: { status: title, threadTs: request.threadTs },
        });
        return;
      }

      case 'tool_execution_end': {
        const toolName = stringValue(event.toolName) ?? 'tool';
        const taskId = stringValue(event.toolCallId) ?? `pi-tool-${toolName}`;
        await sink.onEvent({
          type: 'task-update',
          taskId,
          title: describePiToolCall(toolName, event.args),
          status: event.isError === true ? 'error' : 'complete',
          ...(event.result !== undefined ? { details: stringifyPiDetail(event.result) } : {}),
        });
        state.completedToolTaskIds.add(taskId);
        state.inProgressToolTaskIds.delete(taskId);
        return;
      }

      case 'agent_end': {
        const lastAssistant = [...(event.messages ?? [])]
          .reverse()
          .find((message) => message.role === 'assistant');
        updatePiStateFromMessage(state, lastAssistant);
        return;
      }

      case 'session':
      case 'message_start': {
        updatePiStateFromMessage(state, event.message);
        return;
      }

      default: {
        this.logger.info('Unhandled Pi Agent event type: %s', event.type);
      }
    }
  }

  private async handlePiMessageUpdate(
    event: PiAgentJsonEvent,
    sink: AgentExecutionSink,
    threadTs: string,
    state: PiStreamState,
  ): Promise<void> {
    const assistantEvent = event.assistantMessageEvent;
    updatePiStateFromMessage(state, assistantEvent?.partial ?? event.message);
    const eventType = stringValue(assistantEvent?.type);

    if (eventType === 'thinking_start') {
      await sink.onEvent({
        type: 'activity-state',
        state: { status: 'Pi Agent is reasoning...', threadTs },
      });
      return;
    }

    if (!eventType?.startsWith('toolcall_')) {
      return;
    }
    if (eventType === 'toolcall_delta') {
      return;
    }

    const toolCall = assistantEvent?.toolCall ?? findLatestToolCall(assistantEvent?.partial);
    const toolName = stringValue(toolCall?.name) ?? 'tool';
    const taskId = stringValue(toolCall?.id) ?? `pi-tool-${toolName}`;
    const title = describePiToolCall(toolName, toolCall?.arguments);
    await emitPiToolProgress(sink, state, {
      taskId,
      title,
      ...(toolCall?.arguments !== undefined
        ? { details: stringifyPiDetail(toolCall.arguments) }
        : {}),
    });
    await sink.onEvent({
      type: 'activity-state',
      state: { status: title, threadTs },
    });
  }

  private async handlePiToolResult(
    message: PiAgentMessage,
    sink: AgentExecutionSink,
    state: PiStreamState,
  ): Promise<void> {
    const toolName = stringValue(message.toolName) ?? 'tool';
    const taskId = stringValue(message.toolCallId) ?? `pi-tool-${toolName}`;
    if (state.completedToolTaskIds.has(taskId)) {
      return;
    }
    const output = extractPiTextContent(message.content).trim();
    await sink.onEvent({
      type: 'task-update',
      taskId,
      title: describePiToolCall(toolName),
      status: message.isError === true ? 'error' : 'complete',
      ...(output ? { details: output.slice(0, 2000) } : {}),
    });
    state.completedToolTaskIds.add(taskId);
    state.inProgressToolTaskIds.delete(taskId);
  }

  private async captureStderr(
    child: ChildProcessWithoutNullStreams,
    executionId: string,
    threadTs: string,
    stderrLines: string[],
  ): Promise<void> {
    const rl = readline.createInterface({ input: child.stderr });
    for await (const line of rl) {
      const text = line.trim();
      if (!text) {
        continue;
      }
      stderrLines.push(text);
      this.logger.info(
        'Pi Agent stderr (execution=%s thread=%s): %s',
        executionId,
        threadTs,
        redact(text),
      );
    }
  }

  private attachAbortHandler(
    child: ChildProcessWithoutNullStreams,
    signal: AbortSignal | undefined,
  ): () => void {
    if (!signal) {
      return () => {};
    }
    if (signal.aborted) {
      this.killChild(child);
      return () => {};
    }

    const onAbort = () => {
      this.killChild(child);
    };

    signal.addEventListener('abort', onAbort, { once: true });
    return () => signal.removeEventListener('abort', onAbort);
  }

  private killChild(child: ChildProcessWithoutNullStreams | undefined): void {
    if (!child || child.killed) {
      return;
    }
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    }, ABORT_KILL_TIMEOUT_MS).unref();
  }

  private async applyChannelOps(
    request: AgentExecutionRequest,
    channelOpsPath: string,
  ): Promise<void> {
    if (!this.channelPreferenceStore) {
      return;
    }

    let raw: string;
    try {
      raw = await readFile(channelOpsPath, 'utf8');
    } catch (error) {
      if (isNodeErrorCode(error, 'ENOENT')) {
        return;
      }
      throw error;
    }

    for (const [index, line] of raw.split(/\r?\n/).entries()) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const op = parsePiAgentChannelOp(trimmed);
      if (!op) {
        this.logger.warn('Ignoring invalid Pi Agent channel op on line %d', index + 1);
        continue;
      }
      this.channelPreferenceStore.upsert(request.channelId, op.workspaceInput);
    }
  }

  private toUsageInfo(durationMs: number, state: PiStreamState): SessionUsageInfo {
    const inputTokens = numberValue(state.lastUsage?.input);
    const outputTokens = numberValue(state.lastUsage?.output);
    const cacheReadInputTokens = numberValue(state.lastUsage?.cacheRead);
    const cacheCreationInputTokens = numberValue(state.lastUsage?.cacheWrite);
    const costUSD = numberValue(state.lastUsage?.cost?.total);
    const totalInput = inputTokens + cacheReadInputTokens + cacheCreationInputTokens;
    const cacheHitRate = totalInput > 0 ? (cacheReadInputTokens / totalInput) * 100 : 0;

    return {
      costKnown: costUSD > 0,
      durationMs,
      modelUsage: [
        {
          cacheCreationInputTokens,
          cacheHitRate,
          cacheReadInputTokens,
          costUSD,
          inputTokens,
          inputTokensIncludeCache: true,
          model: state.model ?? env.PI_AGENT_MODEL ?? 'pi-agent',
          outputTokens,
        },
      ],
      totalCostUSD: costUSD,
    };
  }
}

function parsePiAgentArgs(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return ensurePiJsonMode(parsed);
    }
  } catch {
    /* fall through */
  }
  return ensurePiJsonMode(raw.split(/\s+/).filter(Boolean));
}

function ensurePiJsonMode(args: string[]): string[] {
  if (args.includes('--mode')) {
    return args;
  }
  const hasInlineMode = args.some((arg) => arg.startsWith('--mode='));
  return hasInlineMode ? args : [...args, '--mode', 'json'];
}

function formatErrorWithDetails(message: string, stderrLines: string[]): string {
  const tail = stderrLines.slice(-6).join('\n').trim();
  if (!tail || message.includes(tail)) {
    return message;
  }
  return `${message}\n${tail}`;
}

function updatePiStateFromMessage(state: PiStreamState, message: PiAgentMessage | undefined): void {
  if (!message) {
    return;
  }

  const model = stringValue(message.model);
  const provider = stringValue(message.provider);
  if (model) {
    state.model = provider ? `${provider}/${model}` : model;
  }
  if (message.usage) {
    state.lastUsage = message.usage;
  }
  if (message.role === 'assistant') {
    const text = extractPiTextContent(message.content).trim();
    if (text) {
      state.lastAssistantText = text;
    }
  }
}

function extractPiTextContent(content: PiMessageContent[] | undefined): string {
  return (
    content
      ?.map((entry) => (entry.type === 'text' && typeof entry.text === 'string' ? entry.text : ''))
      .filter(Boolean)
      .join('\n') ?? ''
  );
}

function findLatestToolCall(message: PiAgentMessage | undefined): PiToolCall | undefined {
  const toolCall = [...(message?.content ?? [])]
    .reverse()
    .find((entry) => entry.type === 'toolCall');
  if (!toolCall) {
    return undefined;
  }
  return {
    arguments: toolCall.arguments,
    id: toolCall.id,
    name: toolCall.name,
    type: toolCall.type,
  };
}

function describePiToolCall(toolName: string, args?: unknown): string {
  const normalized = toolName.toLowerCase();
  if (normalized === 'ls') {
    return 'Listing files...';
  }
  if (normalized === 'read') {
    return 'Reading file...';
  }
  if (normalized === 'grep') {
    return 'Searching files...';
  }
  if (normalized === 'find') {
    return 'Finding files...';
  }
  if (normalized === 'bash') {
    const command = extractToolArg(args, ['command', 'cmd']);
    return command ? `Running ${command}` : 'Running command...';
  }
  if (normalized === 'edit') {
    return 'Editing file...';
  }
  if (normalized === 'write') {
    return 'Writing file...';
  }
  if (normalized.includes('agent')) {
    return `Running ${toolName}...`;
  }
  return `Using ${toolName}...`;
}

async function emitPiToolProgress(
  sink: AgentExecutionSink,
  state: PiStreamState,
  input: {
    details?: string | undefined;
    taskId: string;
    title: string;
  },
): Promise<void> {
  if (
    state.completedToolTaskIds.has(input.taskId) ||
    state.inProgressToolTaskIds.has(input.taskId)
  ) {
    return;
  }
  state.inProgressToolTaskIds.add(input.taskId);
  await sink.onEvent({
    type: 'task-update',
    taskId: input.taskId,
    title: input.title,
    status: 'in_progress',
    ...(input.details ? { details: input.details } : {}),
  });
}

function extractToolArg(args: unknown, keys: string[]): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return undefined;
  }
  const record = args as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function stringifyPiDetail(value: unknown): string {
  if (typeof value === 'string') {
    return value.slice(0, 2000);
  }
  const text = extractPiToolResultText(value);
  if (text) {
    return text.slice(0, 2000);
  }
  try {
    return JSON.stringify(value, null, 2).slice(0, 2000);
  } catch {
    return String(value).slice(0, 2000);
  }
}

function extractPiToolResultText(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.content)) {
    return undefined;
  }
  const text = record.content
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return '';
      }
      const content = entry as Record<string, unknown>;
      return content.type === 'text' && typeof content.text === 'string' ? content.text : '';
    })
    .filter(Boolean)
    .join('\n');
  return text || undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

async function snapshotGeneratedArtifacts(dir: string): Promise<GeneratedArtifactSnapshot> {
  const entries = new Map<string, GeneratedArtifactSnapshotEntry>();
  await collectGeneratedArtifacts(dir, dir, entries);
  return entries;
}

async function collectGeneratedArtifacts(
  rootDir: string,
  currentDir: string,
  entries: GeneratedArtifactSnapshot,
): Promise<void> {
  let dirents: Dirent<string>[];
  try {
    dirents = await readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  }

  for (const dirent of dirents) {
    const absolutePath = path.join(currentDir, dirent.name);
    if (dirent.isDirectory()) {
      await collectGeneratedArtifacts(rootDir, absolutePath, entries);
      continue;
    }
    if (!dirent.isFile()) {
      continue;
    }

    const fileStat = await stat(absolutePath);
    if (fileStat.size > MAX_GENERATED_ARTIFACT_BYTES) {
      continue;
    }

    const relativePath = path.relative(rootDir, absolutePath);
    entries.set(relativePath, {
      mtimeMs: fileStat.mtimeMs,
      path: absolutePath,
      size: fileStat.size,
    });
  }
}

async function publishGeneratedArtifacts(
  sink: AgentExecutionSink,
  generatedArtifactsDir: string,
  before: GeneratedArtifactSnapshot,
): Promise<void> {
  const after = await snapshotGeneratedArtifacts(generatedArtifactsDir);
  const imageFiles: GeneratedOutputFile[] = [];
  const otherFiles: GeneratedOutputFile[] = [];

  for (const [relativePath, entry] of after) {
    const previous = before.get(relativePath);
    if (previous && previous.mtimeMs === entry.mtimeMs && previous.size === entry.size) {
      continue;
    }

    const file = {
      fileName: path.basename(relativePath),
      path: entry.path,
      providerFileId: `pi-agent-local:${relativePath}`,
    };

    if (GENERATED_IMAGE_FILENAME.test(relativePath)) {
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

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

interface PiAgentChannelOp {
  workspaceInput: string;
}

function parsePiAgentChannelOp(line: string): PiAgentChannelOp | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  if (record.tool !== 'set_channel_default_workspace') {
    return undefined;
  }

  try {
    return parseSetChannelDefaultWorkspaceToolInput(record);
  } catch {
    return undefined;
  }
}
