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
import { env, resolveConfiguredSessionDbPath } from '~/env/server.js';
import type { AppLogger } from '~/logger/index.js';
import { redact } from '~/logger/redact.js';
import type { MemoryStore } from '~/memory/types.js';

import { detectWorkspaceContextFromText } from '../../workspace-context.js';
import { parseSetChannelDefaultWorkspaceToolInput } from '../claude-code/tools/set-channel-default-workspace.js';
import { buildCodexPrompt, getCodexRuntimePaths } from './prompt.js';

const ABORT_KILL_TIMEOUT_MS = 1_000;
const MAX_GENERATED_ARTIFACT_BYTES = 50 * 1024 * 1024;
const GENERATED_IMAGE_FILENAME = /\.(?:gif|jpe?g|png|webp)$/i;
const CODEX_MEMORY_COMMAND_PATTERN = /\bkagura-memory\s+save\b/;
const CODEX_CHANNEL_OPS_COMMAND_PATTERN = /-channel-ops\.jsonl(?:$|[\s"'\\])/;
const KAGURA_MEMORY_SHIM_NAME = 'kagura-memory';

interface GeneratedArtifactSnapshotEntry {
  mtimeMs: number;
  path: string;
  size: number;
}

type GeneratedArtifactSnapshot = Map<string, GeneratedArtifactSnapshotEntry>;

interface CodexJsonEvent {
  error?: unknown;
  item?: CodexJsonItem | undefined;
  message?: unknown;
  thread_id?: unknown;
  type: string;
  usage?:
    | {
        cached_input_tokens?: unknown;
        input_tokens?: unknown;
        output_tokens?: unknown;
      }
    | undefined;
}

interface CodexJsonItem {
  aggregated_output?: unknown;
  command?: unknown;
  exit_code?: unknown;
  id?: unknown;
  status?: unknown;
  text?: unknown;
  type?: unknown;
}

function createAbortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isMissingResumeThreadError(message: string, stderrLines: string[]): boolean {
  const haystack = `${message}\n${stderrLines.join('\n')}`;
  return haystack.includes('thread/resume failed: no rollout found for thread id');
}

function formatErrorWithDetails(
  message: string,
  stderrLines: string[],
  codexErrorLines: string[],
): string {
  const detailLines = uniqueRecentLines(
    [...codexErrorLines, ...stderrLines].map(cleanCodexErrorLine),
  );
  const tail = detailLines.slice(-6).join('\n').trim();
  if (!tail || message.includes(tail)) {
    return message;
  }
  return `${message}\n${tail}`;
}

function uniqueRecentLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function cleanCodexErrorLine(line: string): string {
  return line
    .replace(/^\d{4}-\d{2}-\d{2}T\S+\s+ERROR\s+codex_core::tools::router:\s+error=/, '')
    .trim();
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

function prependPath(entry: string, current: string | undefined): string {
  return current ? `${entry}${path.delimiter}${current}` : entry;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function extractCodexEventError(event: CodexJsonEvent): string | undefined {
  const candidates = [event.message, event.error, event.item?.text, event.item?.aggregated_output];
  for (const candidate of candidates) {
    const extracted = stringifyCodexErrorValue(candidate);
    if (extracted) {
      return extracted;
    }
  }
  return undefined;
}

function stringifyCodexErrorValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.trim() || undefined;
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  for (const key of ['message', 'error', 'detail', 'reason']) {
    const nested = stringifyCodexErrorValue(record[key]);
    if (nested) {
      return nested;
    }
  }

  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

export class CodexCliExecutor implements AgentExecutor {
  readonly providerId = 'codex-cli';
  private readonly activeExecutions = new Set<Promise<void>>();

  constructor(
    private readonly logger: AppLogger,
    private readonly memoryStore?: MemoryStore | undefined,
    private readonly channelPreferenceStore?: ChannelPreferenceStore | undefined,
    private readonly memoryDbPath = resolveConfiguredSessionDbPath(),
  ) {
    this.logger.info(
      'Codex CLI provider configured: model=%s reasoning=%s sandbox=%s',
      env.CODEX_MODEL ?? '(config default)',
      env.CODEX_REASONING_EFFORT ?? '(config default)',
      env.CODEX_CLI_SANDBOX,
    );
  }

  async drain(): Promise<void> {
    if (this.activeExecutions.size > 0) {
      this.logger.info('Draining %d active Codex execution(s)...', this.activeExecutions.size);
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
    const args = this.buildArgs(request);
    const runtimePaths = getCodexRuntimePaths(request, this.memoryDbPath);
    const cwd = request.workspacePath ?? runtimePaths.runtimeDir;
    const prompt = buildCodexPrompt(request, runtimePaths);
    const { channelOpsPath, generatedArtifactsDir, runtimeDir } = runtimePaths;
    let child: ChildProcessWithoutNullStreams | undefined;
    let resumeHandle = request.resumeHandle;
    let started = false;
    let abortCleanup: (() => void) | undefined;
    const codexErrorLines: string[] = [];
    const stderrLines: string[] = [];

    this.logger.info(
      'Codex CLI execution requested (execution=%s thread=%s channel=%s user=%s resume=%s cwd=%s)',
      executionId,
      request.threadTs,
      request.channelId,
      request.userId,
      request.resumeHandle ?? 'none',
      cwd,
    );

    try {
      await mkdir(generatedArtifactsDir, { recursive: true });
      await mkdir(runtimeDir, { recursive: true });
      await writeKaguraMemoryShim(runtimeDir);
      const generatedArtifactsBefore = await snapshotGeneratedArtifacts(generatedArtifactsDir);

      child = spawn('codex', args, {
        cwd,
        env: {
          ...process.env,
          KAGURA_DB_PATH: this.memoryDbPath,
          PATH: prependPath(runtimeDir, process.env.PATH),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      abortCleanup = this.attachAbortHandler(child, request.abortSignal);
      const stderrPromise = this.captureStderr(child, executionId, request.threadTs, stderrLines);
      const stdoutPromise = this.consumeStdout(child, sink, {
        getDurationMs: () => Date.now() - executionStartedAt,
        getResumeHandle: () => resumeHandle,
        markStarted: async (handle) => {
          if (handle) {
            resumeHandle = handle;
          }
          if (started) {
            return;
          }
          started = true;
          await sink.onEvent({
            type: 'lifecycle',
            phase: 'started',
            ...(resumeHandle ? { resumeHandle } : {}),
          });
        },
        recordErrorDetail: (detail) => {
          codexErrorLines.push(detail);
        },
        request,
      });

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
            new Error(`Codex CLI exited with code ${code ?? 'null'} signal ${signal ?? 'none'}`),
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

      if (!started) {
        await sink.onEvent({ type: 'lifecycle', phase: 'started' });
      }
      await this.applyChannelOps(request, channelOpsPath);
      await publishGeneratedArtifacts(sink, generatedArtifactsDir, generatedArtifactsBefore);
      await sink.onEvent({
        type: 'lifecycle',
        phase: 'completed',
        ...(resumeHandle ? { resumeHandle } : {}),
      });
    } catch (error) {
      if (isAbortError(error)) {
        const reason = request.abortSignal?.reason === 'superseded' ? 'superseded' : 'user_stop';
        this.logger.info(
          'Codex CLI execution stopped (execution=%s reason=%s thread=%s)',
          executionId,
          reason,
          request.threadTs,
        );
        this.killChild(child);
        await sink.onEvent({
          type: 'lifecycle',
          phase: 'stopped',
          reason,
          ...(resumeHandle ? { resumeHandle } : {}),
        });
        return;
      }

      const message = formatErrorWithDetails(
        error instanceof Error ? error.message : String(error),
        stderrLines,
        codexErrorLines,
      );
      if (
        request.resumeHandle &&
        !started &&
        isMissingResumeThreadError(message, stderrLines) &&
        !request.abortSignal?.aborted
      ) {
        this.logger.warn(
          'Codex CLI resume handle was not found (execution=%s thread=%s resume=%s); retrying without resume',
          executionId,
          request.threadTs,
          request.resumeHandle,
        );
        const freshRequest: AgentExecutionRequest = { ...request };
        delete freshRequest.resumeHandle;
        await this.executeInternal(freshRequest, sink);
        return;
      }
      this.logger.error(
        'Codex CLI execution failed (execution=%s thread=%s): %s',
        executionId,
        request.threadTs,
        redact(message),
      );
      await sink.onEvent({
        type: 'lifecycle',
        phase: 'failed',
        ...(resumeHandle ? { resumeHandle } : {}),
        error: message,
      });
    } finally {
      abortCleanup?.();
    }
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

    let appliedCount = 0;
    for (const [index, line] of raw.split(/\r?\n/).entries()) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const op = parseCodexChannelOp(trimmed);
      if (!op) {
        this.logger.warn('Ignoring invalid Codex channel op on line %d', index + 1);
        continue;
      }

      const record = this.channelPreferenceStore.upsert(request.channelId, op.workspaceInput);
      appliedCount += 1;
      this.logger.info(
        'Codex channel op set default workspace for %s to %s',
        request.channelId,
        record.defaultWorkspaceInput ?? '(none)',
      );
    }

    if (appliedCount > 0) {
      this.logger.info(
        'Applied %d Codex channel op(s) for thread %s',
        appliedCount,
        request.threadTs,
      );
    }
  }

  private buildArgs(request: AgentExecutionRequest): string[] {
    const model = request.modelOverride ?? env.CODEX_MODEL;
    const modelArgs = model ? ['--model', model] : [];
    const reasoningArgs = env.CODEX_REASONING_EFFORT
      ? ['-c', `model_reasoning_effort="${env.CODEX_REASONING_EFFORT}"`]
      : [];
    const execArgs = [
      '--json',
      '--sandbox',
      env.CODEX_CLI_SANDBOX,
      '-c',
      'approval_policy="never"',
      '--skip-git-repo-check',
      ...modelArgs,
      ...reasoningArgs,
    ];

    if (request.resumeHandle) {
      return [
        'exec',
        'resume',
        '--json',
        '-c',
        `sandbox_mode="${env.CODEX_CLI_SANDBOX}"`,
        '-c',
        'approval_policy="never"',
        '--skip-git-repo-check',
        ...modelArgs,
        ...reasoningArgs,
        request.resumeHandle,
        '-',
      ];
    }

    return ['exec', ...execArgs, '-'];
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

  private async captureStderr(
    child: ChildProcessWithoutNullStreams,
    executionId: string,
    threadTs: string,
    stderrLines: string[],
  ): Promise<void> {
    const rl = readline.createInterface({ input: child.stderr });
    for await (const line of rl) {
      const text = line.trim();
      if (text.length === 0 || text === 'Reading additional input from stdin...') {
        continue;
      }
      stderrLines.push(text);
      this.logger.info(
        'Codex CLI stderr (execution=%s thread=%s): %s',
        executionId,
        threadTs,
        redact(text),
      );
    }
  }

  private async consumeStdout(
    child: ChildProcessWithoutNullStreams,
    sink: AgentExecutionSink,
    handlers: {
      getResumeHandle: () => string | undefined;
      getDurationMs: () => number;
      markStarted: (resumeHandle?: string | undefined) => Promise<void>;
      request: AgentExecutionRequest;
      recordErrorDetail: (detail: string) => void;
    },
  ): Promise<void> {
    const rl = readline.createInterface({ input: child.stdout });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      let event: CodexJsonEvent;
      try {
        event = JSON.parse(trimmed) as CodexJsonEvent;
      } catch {
        this.logger.warn('Ignoring non-JSON Codex CLI stdout line: %s', redact(trimmed));
        continue;
      }

      await this.handleEvent(event, sink, handlers);
    }
  }

  private async handleEvent(
    event: CodexJsonEvent,
    sink: AgentExecutionSink,
    handlers: {
      getResumeHandle: () => string | undefined;
      getDurationMs: () => number;
      markStarted: (resumeHandle?: string | undefined) => Promise<void>;
      request: AgentExecutionRequest;
      recordErrorDetail: (detail: string) => void;
    },
  ): Promise<void> {
    switch (event.type) {
      case 'thread.started': {
        await handlers.markStarted(
          typeof event.thread_id === 'string' ? event.thread_id : undefined,
        );
        return;
      }

      case 'turn.started': {
        await handlers.markStarted(handlers.getResumeHandle());
        await sink.onEvent({
          type: 'activity-state',
          state: {
            status: 'Codex is thinking...',
            threadTs: handlers.request.threadTs,
          },
        });
        return;
      }

      case 'item.started':
      case 'item.completed': {
        await this.handleItemEvent(event, sink, handlers.request);
        return;
      }

      case 'turn.completed': {
        await sink.onEvent({
          type: 'usage-info',
          usage: this.toUsageInfo(event, handlers.getDurationMs(), handlers.request),
        });
        await sink.onEvent({
          type: 'activity-state',
          state: { clear: true, threadTs: handlers.request.threadTs },
        });
        return;
      }

      case 'error':
      case 'turn.failed': {
        const detail = extractCodexEventError(event);
        if (detail) {
          handlers.recordErrorDetail(detail);
          this.logger.info('Codex CLI %s detail: %s', event.type, redact(detail));
        } else {
          this.logger.info('Codex CLI emitted %s without a visible detail', event.type);
        }
        if (event.type === 'turn.failed') {
          await sink.onEvent({
            type: 'activity-state',
            state: { clear: true, threadTs: handlers.request.threadTs },
          });
        }
        return;
      }

      default: {
        this.logger.info('Unhandled Codex CLI event type: %s', event.type);
      }
    }
  }

  private async handleItemEvent(
    event: CodexJsonEvent,
    sink: AgentExecutionSink,
    request: AgentExecutionRequest,
  ): Promise<void> {
    const item = event.item;
    if (!item) {
      return;
    }

    if (item.type === 'agent_message' && event.type === 'item.completed') {
      const text = typeof item.text === 'string' ? item.text.trim() : undefined;
      if (text) {
        await maybeEmitWorkspaceContextFromText(text, request, sink);
        await sink.onEvent({ type: 'assistant-message', text });
      }
      return;
    }

    if (item.type !== 'command_execution') {
      return;
    }

    const command = typeof item.command === 'string' ? item.command : undefined;
    const taskId = typeof item.id === 'string' ? item.id : (command ?? 'codex-command');
    const title = command ? describeCodexCommand(command) : 'Running command';
    const exitCode = typeof item.exit_code === 'number' ? item.exit_code : undefined;
    const itemStatus = typeof item.status === 'string' ? item.status : undefined;
    const aggregatedOutput =
      typeof item.aggregated_output === 'string' ? item.aggregated_output.trim() : undefined;
    const status =
      event.type === 'item.started'
        ? 'in_progress'
        : exitCode === 0 || itemStatus === 'completed'
          ? 'complete'
          : 'error';

    await sink.onEvent({
      type: 'task-update',
      taskId,
      title,
      status,
      ...(aggregatedOutput ? { details: aggregatedOutput.slice(0, 2000) } : {}),
    });
    await maybeEmitWorkspaceContextFromText(
      [command, aggregatedOutput].filter(Boolean).join('\n'),
      request,
      sink,
    );

    if (status === 'in_progress') {
      await sink.onEvent({
        type: 'activity-state',
        state: {
          status: title,
          threadTs: request.threadTs,
        },
      });
    }
  }

  private toUsageInfo(
    event: CodexJsonEvent,
    durationMs: number,
    request: AgentExecutionRequest,
  ): SessionUsageInfo {
    const inputTokens =
      typeof event.usage?.input_tokens === 'number' ? event.usage.input_tokens : 0;
    const cacheReadInputTokens =
      typeof event.usage?.cached_input_tokens === 'number' ? event.usage.cached_input_tokens : 0;
    const outputTokens =
      typeof event.usage?.output_tokens === 'number' ? event.usage.output_tokens : 0;
    const cacheHitRate = inputTokens > 0 ? (cacheReadInputTokens / inputTokens) * 100 : 0;

    return {
      costKnown: false,
      durationMs,
      modelUsage: [
        {
          cacheCreationInputTokens: 0,
          cacheHitRate,
          cacheReadInputTokens,
          costUSD: 0,
          inputTokensIncludeCache: true,
          inputTokens,
          model: request.modelOverride ?? env.CODEX_MODEL ?? 'codex-cli',
          outputTokens,
        },
      ],
      totalCostUSD: 0,
    };
  }
}

function describeCodexCommand(command: string): string {
  if (CODEX_MEMORY_COMMAND_PATTERN.test(command)) {
    return 'Saving memory...';
  }
  if (CODEX_CHANNEL_OPS_COMMAND_PATTERN.test(command)) {
    return 'Setting channel workspace...';
  }

  return unwrapShellLoginCommand(command);
}

function unwrapShellLoginCommand(command: string): string {
  const trimmed = command.trim();
  const shellPrefix = findShellLoginPrefix(trimmed);
  if (!shellPrefix) {
    return trimmed;
  }

  const shellCommand = trimmed.slice(shellPrefix.length).trim();
  if (!shellCommand) {
    return trimmed;
  }

  return unquoteShellArgument(shellCommand) ?? shellCommand;
}

function findShellLoginPrefix(command: string): string | undefined {
  const prefixes = [
    '/bin/bash -lc ',
    '/bin/zsh -lc ',
    '/bin/fish -lc ',
    '/usr/bin/bash -lc ',
    '/usr/bin/zsh -lc ',
    '/usr/bin/fish -lc ',
    'bash -lc ',
    'zsh -lc ',
    'fish -lc ',
    'sh -lc ',
  ];

  return prefixes.find((prefix) => command.startsWith(prefix));
}

function unquoteShellArgument(value: string): string | undefined {
  if (value.length < 2) {
    return undefined;
  }

  const quote = value[0];
  if ((quote !== "'" && quote !== '"') || value.at(-1) !== quote) {
    return undefined;
  }

  const inner = value.slice(1, -1);
  if (quote === "'") {
    return inner;
  }

  return inner.replaceAll(/\\(["$\\`])/g, '$1');
}

async function maybeEmitWorkspaceContextFromText(
  text: string,
  request: AgentExecutionRequest,
  sink: AgentExecutionSink,
): Promise<void> {
  const workspaceContext = detectWorkspaceContextFromText(text, {
    originalWorkspaceLabel: request.workspaceLabel,
    originalWorkspacePath: request.workspacePath,
    workspaceRepoId: request.workspaceRepoId,
  });
  if (!workspaceContext) {
    return;
  }

  await sink.onEvent({
    type: 'workspace-context',
    ...workspaceContext,
  });
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
      providerFileId: `codex-local:${relativePath}`,
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

interface CodexChannelOp {
  workspaceInput: string;
}

function parseCodexChannelOp(line: string): CodexChannelOp | undefined {
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
