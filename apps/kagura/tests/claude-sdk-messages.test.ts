import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  SDKAPIRetryMessage,
  SDKAssistantMessage,
  SDKFilesPersistedEvent,
  SDKSystemMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleClaudeSdkMessage } from '~/agent/providers/claude-code/messages.js';
import { createRuntimeUiStateTracker } from '~/agent/providers/claude-code/runtime-ui.js';
import type { MessageHandlers } from '~/agent/providers/claude-code/types.js';
import type { AgentExecutionEvent, AgentExecutionSink } from '~/agent/types.js';
import type { AppLogger } from '~/logger/index.js';

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

function minimalInitMessage(cwd: string): SDKSystemMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: 'sess-test',
    cwd,
    model: 'test-model',
    apiKeySource: 'project',
    claude_code_version: '0.0.0',
    tools: [],
    mcp_servers: [],
    permissionMode: 'default',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: '00000000-0000-4000-8000-000000000000',
  };
}

function createGitWorktreeFixture(): { repoPath: string; worktreePath: string } {
  const repoPath = mkdtempSync(path.join(tmpdir(), 'claude-worktree-source-'));
  const worktreePath = mkdtempSync(path.join(tmpdir(), 'claude-worktree-target-'));
  rmSync(worktreePath, { force: true, recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: repoPath,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoPath, stdio: 'ignore' });
  writeFileSync(path.join(repoPath, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', '.'], { cwd: repoPath, stdio: 'ignore' });
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'initial'], {
    cwd: repoPath,
    stdio: 'ignore',
  });
  execFileSync('git', ['remote', 'add', 'origin', 'git@example.com:Innei/kagura.git'], {
    cwd: repoPath,
    stdio: 'ignore',
  });
  execFileSync('git', ['worktree', 'add', '-b', 'feature/claude-worktree', worktreePath], {
    cwd: repoPath,
    stdio: 'ignore',
  });
  return { repoPath, worktreePath };
}

function minimalAssistantMessage(text: string): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: {
      id: 'msg-test',
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    parent_tool_use_id: null,
    uuid: '00000000-0000-4000-8000-000000000010',
    session_id: 'sess-test',
  } as unknown as SDKAssistantMessage;
}

describe('handleClaudeSdkMessage — files_persisted', () => {
  let sessionCwd: string | undefined;
  let handlers: MessageHandlers;
  let events: AgentExecutionEvent[];
  let sink: AgentExecutionSink;

  beforeEach(() => {
    sessionCwd = undefined;
    events = [];
    sink = {
      onEvent: async (event) => {
        events.push(event);
      },
    };
    handlers = {
      publishUiState: vi.fn().mockResolvedValue(undefined),
      runtimeUi: createRuntimeUiStateTracker(),
      setSessionId: vi.fn(),
      getSessionCwd: () => sessionCwd,
      setSessionCwd: (cwd: string) => {
        sessionCwd = cwd;
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits generated-images for persisted image files with paths resolved from session cwd', async () => {
    const root = '/tmp/claude-session-root';
    await handleClaudeSdkMessage(createTestLogger(), minimalInitMessage(root), sink, handlers);

    const persisted: SDKFilesPersistedEvent = {
      type: 'system',
      subtype: 'files_persisted',
      session_id: 'sess-test',
      uuid: '00000000-0000-4000-8000-000000000001',
      processed_at: new Date().toISOString(),
      failed: [],
      files: [
        { filename: 'out/screenshot.png', file_id: 'file-abc' },
        { filename: 'notes/readme.txt', file_id: 'file-txt' },
      ],
    };

    await handleClaudeSdkMessage(createTestLogger(), persisted, sink, handlers);

    const imgEvents = events.filter(
      (e): e is Extract<AgentExecutionEvent, { type: 'generated-images' }> =>
        e.type === 'generated-images',
    );
    const fileEvents = events.filter(
      (e): e is Extract<AgentExecutionEvent, { type: 'generated-files' }> =>
        e.type === 'generated-files',
    );
    expect(imgEvents).toHaveLength(1);
    expect(imgEvents[0]!.files).toEqual([
      {
        fileName: 'out/screenshot.png',
        path: path.resolve(root, 'out/screenshot.png'),
        providerFileId: 'file-abc',
      },
    ]);
    expect(fileEvents).toHaveLength(1);
    expect(fileEvents[0]!.files).toEqual([
      {
        fileName: 'notes/readme.txt',
        path: path.resolve(root, 'notes/readme.txt'),
        providerFileId: 'file-txt',
      },
    ]);
  });

  it('emits generated-files for persisted non-image files', async () => {
    await handleClaudeSdkMessage(createTestLogger(), minimalInitMessage('/tmp/ws'), sink, handlers);

    const persisted: SDKFilesPersistedEvent = {
      type: 'system',
      subtype: 'files_persisted',
      session_id: 'sess-test',
      uuid: '00000000-0000-4000-8000-000000000002',
      processed_at: new Date().toISOString(),
      failed: [],
      files: [{ filename: 'data.csv', file_id: 'id-1' }],
    };

    await handleClaudeSdkMessage(createTestLogger(), persisted, sink, handlers);

    expect(events.filter((e) => e.type === 'generated-images')).toHaveLength(0);
    const fileEvents = events.filter(
      (e): e is Extract<AgentExecutionEvent, { type: 'generated-files' }> =>
        e.type === 'generated-files',
    );
    expect(fileEvents).toHaveLength(1);
    expect(fileEvents[0]!.files).toEqual([
      {
        fileName: 'data.csv',
        path: path.resolve('/tmp/ws', 'data.csv'),
        providerFileId: 'id-1',
      },
    ]);
  });

  it('resolves paths against process.cwd() when session cwd was not set', async () => {
    const fallback = '/fallback/cwd';
    const spy = vi.spyOn(process, 'cwd').mockReturnValue(fallback);

    const persisted: SDKFilesPersistedEvent = {
      type: 'system',
      subtype: 'files_persisted',
      session_id: 'sess-test',
      uuid: '00000000-0000-4000-8000-000000000003',
      processed_at: new Date().toISOString(),
      failed: [],
      files: [{ filename: 'img.JPEG', file_id: 'id-2' }],
    };

    await handleClaudeSdkMessage(createTestLogger(), persisted, sink, handlers);

    expect(spy).toHaveBeenCalled();
    const imgEvents = events.filter(
      (e): e is Extract<AgentExecutionEvent, { type: 'generated-images' }> =>
        e.type === 'generated-images',
    );
    expect(imgEvents).toHaveLength(1);
    expect(imgEvents[0]!.files[0]!.path).toBe(path.resolve(fallback, 'img.JPEG'));

    spy.mockRestore();
  });
});

describe('handleClaudeSdkMessage — workspace context', () => {
  let sessionCwd: string | undefined;
  let events: AgentExecutionEvent[];
  let sink: AgentExecutionSink;

  beforeEach(() => {
    sessionCwd = undefined;
    events = [];
    sink = {
      onEvent: async (event) => {
        events.push(event);
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createHandlers(workspacePath: string): MessageHandlers {
    return {
      publishUiState: vi.fn().mockResolvedValue(undefined),
      runtimeUi: createRuntimeUiStateTracker(),
      setSessionId: vi.fn(),
      getSessionCwd: () => sessionCwd,
      setSessionCwd: (cwd: string) => {
        sessionCwd = cwd;
      },
      workspaceContext: {
        workspaceLabel: 'slack-cc-bot',
        workspacePath,
        workspaceRepoId: 'innei-repo/slack-cc-bot',
      },
    };
  }

  it('emits workspace-context when Claude SDK init reports a worktree cwd', async () => {
    const { repoPath, worktreePath } = createGitWorktreeFixture();
    const handlers = createHandlers(repoPath);

    await handleClaudeSdkMessage(
      createTestLogger(),
      minimalInitMessage(worktreePath),
      sink,
      handlers,
    );

    const resolvedWorktreePath = execFileSync(
      'git',
      ['-C', worktreePath, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8' },
    ).trim();
    expect(events).toContainEqual({
      type: 'workspace-context',
      workspaceLabel: path.basename(worktreePath),
      workspacePath: resolvedWorktreePath,
      workspaceRepoId: 'innei-repo/slack-cc-bot',
    });
  });

  it('emits workspace-context before final assistant text when Claude mentions a worktree path', async () => {
    const { repoPath, worktreePath } = createGitWorktreeFixture();
    const handlers = createHandlers(repoPath);

    await handleClaudeSdkMessage(
      createTestLogger(),
      minimalAssistantMessage(`Implemented in ${worktreePath}`),
      sink,
      handlers,
    );

    expect(events[0]).toMatchObject({
      type: 'workspace-context',
      workspaceLabel: path.basename(worktreePath),
      workspaceRepoId: 'innei-repo/slack-cc-bot',
    });
    expect(events[1]).toEqual({
      type: 'assistant-message',
      text: `Implemented in ${worktreePath}`,
    });
  });
});

describe('handleClaudeSdkMessage — api_retry', () => {
  it('publishes retry status with attempt, HTTP status, and error kind', async () => {
    const handlers: MessageHandlers = {
      publishUiState: vi.fn().mockResolvedValue(undefined),
      runtimeUi: createRuntimeUiStateTracker(),
      setSessionId: vi.fn(),
      getSessionCwd: () => undefined,
      setSessionCwd: vi.fn(),
    };
    const message: SDKAPIRetryMessage = {
      type: 'system',
      subtype: 'api_retry',
      attempt: 2,
      max_retries: 5,
      retry_delay_ms: 1_000,
      error_status: 529,
      error: 'server_error',
      uuid: '00000000-0000-4000-8000-000000000003',
      session_id: 'sess-test',
    };

    await handleClaudeSdkMessage(createTestLogger(), message, { onEvent: vi.fn() }, handlers);

    expect(handlers.runtimeUi.systemStatuses.retry).toBe(
      'Retrying Claude API request (attempt 2/5, HTTP 529, server_error)...',
    );
    expect(handlers.runtimeUi.loadingMessages).toContain(
      'Retrying Claude API request (attempt 2/5, HTTP 529, server_error)...',
    );
    expect(handlers.publishUiState).toHaveBeenCalledTimes(1);
  });

  it('labels retry events without an HTTP response as network failures', async () => {
    const handlers: MessageHandlers = {
      publishUiState: vi.fn().mockResolvedValue(undefined),
      runtimeUi: createRuntimeUiStateTracker(),
      setSessionId: vi.fn(),
      getSessionCwd: () => undefined,
      setSessionCwd: vi.fn(),
    };
    const message: SDKAPIRetryMessage = {
      type: 'system',
      subtype: 'api_retry',
      attempt: 1,
      max_retries: 3,
      retry_delay_ms: 500,
      error_status: null,
      error: 'unknown',
      uuid: '00000000-0000-4000-8000-000000000004',
      session_id: 'sess-test',
    };

    await handleClaudeSdkMessage(createTestLogger(), message, { onEvent: vi.fn() }, handlers);

    expect(handlers.runtimeUi.systemStatuses.retry).toBe(
      'Retrying Claude API request (attempt 1/3, network/no HTTP response, unknown)...',
    );
  });
});
