import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CodexCliExecutor } from '~/agent/providers/codex-cli/adapter.js';
import { buildCodexPrompt, getCodexRuntimePaths } from '~/agent/providers/codex-cli/prompt.js';
import type { AgentExecutionEvent, AgentExecutionRequest } from '~/agent/types.js';
import type {
  ChannelPreferenceRecord,
  ChannelPreferenceStore,
} from '~/channel-preference/types.js';
import type { AppLogger } from '~/logger/index.js';

const spawnMock = vi.hoisted(() => vi.fn());
const TEST_SESSION_DB_PATH = path.resolve(process.cwd(), './data/test-sessions.db');

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: spawnMock,
  };
});

class FakeCodexProcess extends EventEmitter {
  readonly stderr = new PassThrough();
  readonly stdout = new PassThrough();
  killed = false;
  readonly stdin: Writable;

  constructor(private readonly onPrompt: (prompt: string, child: FakeCodexProcess) => void) {
    super();
    let prompt = '';
    this.stdin = new Writable({
      write(chunk, _encoding, callback) {
        prompt += String(chunk);
        callback();
      },
      final: (callback) => {
        this.onPrompt(prompt, this);
        callback();
      },
    });
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    queueMicrotask(() => {
      this.stdout.end();
      this.stderr.end();
      this.emit('exit', null, signal ?? 'SIGTERM');
    });
    return true;
  }
}

function createRequest(overrides: Partial<AgentExecutionRequest> = {}): AgentExecutionRequest {
  return {
    channelId: 'C1',
    mentionText: 'hello',
    threadContext: {
      channelId: 'C1',
      fileLoadFailures: [],
      imageLoadFailures: [],
      loadedFiles: [],
      loadedImages: [],
      messages: [],
      renderedPrompt: '',
      threadTs: '1712345678.000100',
    },
    threadTs: '1712345678.000100',
    userId: 'U1',
    ...overrides,
  };
}

function createLogger(): AppLogger {
  return {
    child: () => createLogger(),
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    success: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
    withTag: () => createLogger(),
  } as unknown as AppLogger;
}

function createSink(events: AgentExecutionEvent[]) {
  return {
    onEvent: vi.fn(async (event: AgentExecutionEvent) => {
      events.push(event);
    }),
  };
}

function writeJson(child: FakeCodexProcess, value: unknown): void {
  child.stdout.write(`${JSON.stringify(value)}\n`);
}

function createChannelPreferenceStore(
  saved: ChannelPreferenceRecord[] = [],
): ChannelPreferenceStore {
  return {
    get: vi.fn(),
    upsert: vi.fn((channelId: string, defaultWorkspaceInput: string | undefined) => {
      const record: ChannelPreferenceRecord = {
        channelId,
        defaultWorkspaceInput,
        createdAt: '2026-04-24T00:00:00.000Z',
        updatedAt: '2026-04-24T00:00:00.000Z',
      };
      saved.push(record);
      return record;
    }),
  };
}

function createGitWorktreeFixture(): { repoPath: string; worktreePath: string } {
  const repoPath = mkdtempSync(path.join(tmpdir(), 'codex-worktree-source-'));
  const worktreePath = mkdtempSync(path.join(tmpdir(), 'codex-worktree-target-'));
  execFileSync('rm', ['-rf', worktreePath]);
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
  execFileSync('git', ['worktree', 'add', '-b', 'feature/worktree', worktreePath], {
    cwd: repoPath,
    stdio: 'ignore',
  });
  return { repoPath, worktreePath };
}

describe('CodexCliExecutor', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('maps Codex JSONL events to agent execution events', async () => {
    const request = createRequest();
    const runtimePaths = getCodexRuntimePaths(request);

    spawnMock.mockImplementation(
      () =>
        new FakeCodexProcess((_prompt, child) => {
          queueMicrotask(() => {
            writeJson(child, { type: 'thread.started', thread_id: 'codex-thread-1' });
            writeJson(child, { type: 'turn.started' });
            writeJson(child, {
              type: 'item.started',
              item: {
                id: 'cmd-1',
                type: 'command_execution',
                command: '/bin/zsh -lc pwd',
                status: 'in_progress',
              },
            });
            writeJson(child, {
              type: 'item.completed',
              item: {
                id: 'cmd-1',
                type: 'command_execution',
                command: '/bin/zsh -lc pwd',
                aggregated_output: '/tmp/project\n',
                exit_code: 0,
                status: 'completed',
              },
            });
            writeJson(child, {
              type: 'item.completed',
              item: { id: 'msg-1', type: 'agent_message', text: 'done' },
            });
            writeJson(child, {
              type: 'turn.completed',
              usage: {
                cached_input_tokens: 20,
                input_tokens: 100,
                output_tokens: 5,
              },
            });
            child.stdout.end();
            child.stderr.end();
            child.emit('exit', 0, null);
          });
        }),
    );

    const events: AgentExecutionEvent[] = [];
    await new CodexCliExecutor(createLogger()).execute(request, createSink(events));

    expect(spawnMock).toHaveBeenCalledWith(
      'codex',
      expect.arrayContaining(['exec', '--json', '--sandbox', 'danger-full-access']),
      expect.objectContaining({
        env: expect.objectContaining({
          KAGURA_DB_PATH: TEST_SESSION_DB_PATH,
          PATH: expect.stringContaining(runtimePaths.runtimeDir),
        }),
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
    expect(events).toContainEqual({
      type: 'lifecycle',
      phase: 'started',
      resumeHandle: 'codex-thread-1',
    });
    expect(events).toContainEqual({
      type: 'assistant-message',
      text: 'done',
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'task-update',
        taskId: 'cmd-1',
        status: 'complete',
        title: 'pwd',
      }),
    );
    expect(events).toContainEqual({
      type: 'activity-state',
      state: {
        status: 'pwd',
        threadTs: '1712345678.000100',
      },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'usage-info',
        usage: expect.objectContaining({
          modelUsage: [
            expect.objectContaining({
              cacheHitRate: 20,
              inputTokensIncludeCache: true,
              inputTokens: 100,
              outputTokens: 5,
            }),
          ],
        }),
      }),
    );
    expect(events.at(-1)).toEqual({
      type: 'lifecycle',
      phase: 'completed',
      resumeHandle: 'codex-thread-1',
    });
  });

  it('emits workspace context when Codex reports worktree activity', async () => {
    const { repoPath, worktreePath } = createGitWorktreeFixture();
    const request = createRequest({
      workspaceLabel: 'slack-cc-bot',
      workspacePath: repoPath,
      workspaceRepoId: 'innei-repo/slack-cc-bot',
    });

    spawnMock.mockImplementation(
      () =>
        new FakeCodexProcess((_prompt, child) => {
          queueMicrotask(() => {
            writeJson(child, { type: 'thread.started', thread_id: 'codex-thread-1' });
            writeJson(child, {
              type: 'item.completed',
              item: {
                id: 'msg-1',
                type: 'agent_message',
                text: `Implemented in ${worktreePath}`,
              },
            });
            child.stdout.end();
            child.stderr.end();
            child.emit('exit', 0, null);
          });
        }),
    );

    const events: AgentExecutionEvent[] = [];
    await new CodexCliExecutor(createLogger()).execute(request, createSink(events));

    const resolvedWorktreePath = execFileSync(
      'git',
      ['-C', worktreePath, 'rev-parse', '--show-toplevel'],
      {
        encoding: 'utf8',
      },
    ).trim();
    expect(events).toContainEqual({
      type: 'workspace-context',
      workspaceLabel: path.basename(worktreePath),
      workspacePath: resolvedWorktreePath,
      workspaceRepoId: 'innei-repo/slack-cc-bot',
    });
    expect(events).toContainEqual({
      type: 'assistant-message',
      text: `Implemented in ${worktreePath}`,
    });
  });

  it('uses codex exec resume when a resume handle exists', async () => {
    spawnMock.mockImplementation(
      () =>
        new FakeCodexProcess((_prompt, child) => {
          queueMicrotask(() => {
            writeJson(child, { type: 'thread.started', thread_id: 'codex-thread-1' });
            writeJson(child, { type: 'turn.completed', usage: {} });
            child.stdout.end();
            child.stderr.end();
            child.emit('exit', 0, null);
          });
        }),
    );

    await new CodexCliExecutor(createLogger()).execute(
      createRequest({ resumeHandle: 'codex-thread-1' }),
      createSink([]),
    );

    expect(spawnMock).toHaveBeenCalledWith(
      'codex',
      expect.arrayContaining([
        'exec',
        'resume',
        '--json',
        '-c',
        'sandbox_mode="danger-full-access"',
        'codex-thread-1',
        '-',
      ]),
      expect.any(Object),
    );
  });

  it('retries without resume when Codex no longer has the saved rollout', async () => {
    spawnMock
      .mockImplementationOnce(
        () =>
          new FakeCodexProcess((_prompt, child) => {
            queueMicrotask(() => {
              child.stderr.write(
                'Error: thread/resume: thread/resume failed: no rollout found for thread id codex-thread-1\n',
              );
              child.stdout.end();
              child.stderr.end();
              child.emit('exit', 1, null);
            });
          }),
      )
      .mockImplementationOnce(
        () =>
          new FakeCodexProcess((_prompt, child) => {
            queueMicrotask(() => {
              writeJson(child, { type: 'thread.started', thread_id: 'codex-thread-2' });
              writeJson(child, {
                type: 'item.completed',
                item: { id: 'msg-1', type: 'agent_message', text: 'fresh session' },
              });
              writeJson(child, { type: 'turn.completed', usage: {} });
              child.stdout.end();
              child.stderr.end();
              child.emit('exit', 0, null);
            });
          }),
      );

    const events: AgentExecutionEvent[] = [];
    await new CodexCliExecutor(createLogger()).execute(
      createRequest({ resumeHandle: 'codex-thread-1' }),
      createSink(events),
    );

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(['exec', 'resume', 'codex-thread-1', '-']),
    );
    expect(spawnMock.mock.calls[1]?.[1]).toEqual(
      expect.not.arrayContaining(['resume', 'codex-thread-1']),
    );
    expect(events).not.toContainEqual(expect.objectContaining({ phase: 'failed' }));
    expect(events).toContainEqual({
      type: 'assistant-message',
      text: 'fresh session',
    });
    expect(events.at(-1)).toEqual({
      type: 'lifecycle',
      phase: 'completed',
      resumeHandle: 'codex-thread-2',
    });
  });

  it('includes Codex error events and stderr details in failed lifecycle events', async () => {
    spawnMock.mockImplementation(
      () =>
        new FakeCodexProcess((_prompt, child) => {
          queueMicrotask(() => {
            writeJson(child, {
              type: 'thread.started',
              thread_id: 'codex-thread-1',
            });
            writeJson(child, {
              type: 'error',
              message: 'apply_patch failed while editing MainLexicalContent.tsx',
            });
            writeJson(child, {
              type: 'turn.failed',
              error: {
                message: 'tool execution failed',
              },
            });
            child.stderr.write(
              '2026-04-25T16:56:57.539984Z ERROR codex_core::tools::router: error=apply_patch verification failed: Failed to find expected lines in /repo/MainLexicalContent.tsx:\n',
            );
            child.stderr.write("import type { SerializedEditorState } from 'lexical'\n");
            child.stdout.end();
            child.stderr.end();
            child.emit('exit', 1, null);
          });
        }),
    );

    const events: AgentExecutionEvent[] = [];
    await new CodexCliExecutor(createLogger()).execute(createRequest(), createSink(events));

    expect(events).toContainEqual({
      type: 'activity-state',
      state: { clear: true, threadTs: '1712345678.000100' },
    });
    expect(events.at(-1)).toEqual({
      type: 'lifecycle',
      phase: 'failed',
      resumeHandle: 'codex-thread-1',
      error: expect.stringContaining(
        'apply_patch verification failed: Failed to find expected lines in /repo/MainLexicalContent.tsx:',
      ),
    });
    expect(events.at(-1)).toEqual({
      type: 'lifecycle',
      phase: 'failed',
      resumeHandle: 'codex-thread-1',
      error: expect.stringContaining("import type { SerializedEditorState } from 'lexical'"),
    });
    expect(events.at(-1)).toEqual({
      type: 'lifecycle',
      phase: 'failed',
      resumeHandle: 'codex-thread-1',
      error: expect.stringContaining('apply_patch failed while editing MainLexicalContent.tsx'),
    });
  });

  it('emits generated-images for new Codex artifact files', async () => {
    const workspacePath = mkdtempSync(path.join(tmpdir(), 'codex-artifacts-'));
    const request = createRequest({ workspacePath });
    const runtimePaths = getCodexRuntimePaths(request);
    const imagePath = path.join(runtimePaths.generatedArtifactsDir, 'blue.png');

    spawnMock.mockImplementation(
      () =>
        new FakeCodexProcess((prompt, child) => {
          expect(prompt).toContain(runtimePaths.generatedArtifactsDir);
          queueMicrotask(() => {
            writeFileSync(imagePath, Buffer.from('89504e470d0a1a0a', 'hex'));
            writeJson(child, { type: 'thread.started', thread_id: 'codex-thread-1' });
            writeJson(child, {
              type: 'item.completed',
              item: { id: 'msg-1', type: 'agent_message', text: 'LIVE_E2E_IMAGE_OK OUTBOUND' },
            });
            writeJson(child, { type: 'turn.completed', usage: {} });
            child.stdout.end();
            child.stderr.end();
            child.emit('exit', 0, null);
          });
        }),
    );

    const events: AgentExecutionEvent[] = [];
    await new CodexCliExecutor(createLogger()).execute(request, createSink(events));

    expect(events).toContainEqual({
      type: 'generated-images',
      files: [
        {
          fileName: 'blue.png',
          path: imagePath,
          providerFileId: 'codex-local:blue.png',
        },
      ],
    });
    expect(existsSync(path.join(workspacePath, '.kagura'))).toBe(false);
    expect(events.at(-1)).toEqual({
      type: 'lifecycle',
      phase: 'completed',
      resumeHandle: 'codex-thread-1',
    });
  });

  it('runs Codex from the runtime directory when no workspace is resolved', async () => {
    const request = createRequest({ executionId: 'exec-no-workspace' });
    const runtimePaths = getCodexRuntimePaths(request);

    spawnMock.mockImplementation(
      () =>
        new FakeCodexProcess((_prompt, child) => {
          queueMicrotask(() => {
            writeJson(child, { type: 'thread.started', thread_id: 'codex-thread-1' });
            writeJson(child, { type: 'turn.completed', usage: {} });
            child.stdout.end();
            child.stderr.end();
            child.emit('exit', 0, null);
          });
        }),
    );

    await new CodexCliExecutor(createLogger()).execute(request, createSink([]));

    expect(spawnMock).toHaveBeenCalledWith(
      'codex',
      expect.any(Array),
      expect.objectContaining({ cwd: runtimePaths.runtimeDir }),
    );
  });

  it('codex prompt mentions kagura-memory CLI for memory ops', () => {
    const prompt = buildCodexPrompt(createRequest());
    expect(prompt).toContain(`KAGURA_DB_PATH='${TEST_SESSION_DB_PATH}' kagura-memory save`);
    expect(prompt).toContain(`KAGURA_DB_PATH='${TEST_SESSION_DB_PATH}' kagura-memory recall`);
    expect(prompt).not.toContain('memory-ops.jsonl');
  });

  it('applies Codex set_channel_default_workspace JSONL operations after execution', async () => {
    const request = createRequest({ executionId: 'exec-channel-pref' });
    const { channelOpsPath } = getCodexRuntimePaths(request);
    const saved: ChannelPreferenceRecord[] = [];
    const channelPreferenceStore = createChannelPreferenceStore(saved);

    spawnMock.mockImplementation(
      () =>
        new FakeCodexProcess((prompt, child) => {
          expect(prompt).toContain(channelOpsPath);
          queueMicrotask(() => {
            writeFileSync(
              channelOpsPath,
              `${JSON.stringify({
                tool: 'set_channel_default_workspace',
                workspaceInput: 'LobeHub',
              })}\n`,
            );
            writeJson(child, { type: 'thread.started', thread_id: 'codex-thread-1' });
            writeJson(child, {
              type: 'item.completed',
              item: { id: 'msg-1', type: 'agent_message', text: 'workspace saved' },
            });
            writeJson(child, { type: 'turn.completed', usage: {} });
            child.stdout.end();
            child.stderr.end();
            child.emit('exit', 0, null);
          });
        }),
    );

    await new CodexCliExecutor(createLogger(), undefined, channelPreferenceStore).execute(
      request,
      createSink([]),
    );

    expect(channelPreferenceStore.upsert).toHaveBeenCalledWith('C1', 'LobeHub');
    expect(saved).toHaveLength(1);
  });

  it('renders Codex kagura-memory save commands as a concise memory activity', async () => {
    const request = createRequest({ executionId: 'exec-memory' });
    const command =
      '/bin/zsh -lc \'kagura-memory save --category preference --content "x" --scope global\'';

    spawnMock.mockImplementation(
      () =>
        new FakeCodexProcess((_prompt, child) => {
          queueMicrotask(() => {
            writeJson(child, { type: 'thread.started', thread_id: 'codex-thread-1' });
            writeJson(child, { type: 'turn.started' });
            writeJson(child, {
              type: 'item.started',
              item: {
                id: 'cmd-memory',
                type: 'command_execution',
                command,
                status: 'in_progress',
              },
            });
            writeJson(child, {
              type: 'item.completed',
              item: {
                id: 'cmd-memory',
                type: 'command_execution',
                command,
                exit_code: 0,
                status: 'completed',
              },
            });
            writeJson(child, { type: 'turn.completed', usage: {} });
            child.stdout.end();
            child.stderr.end();
            child.emit('exit', 0, null);
          });
        }),
    );

    const events: AgentExecutionEvent[] = [];
    await new CodexCliExecutor(createLogger()).execute(request, createSink(events));

    expect(events).toContainEqual({
      type: 'activity-state',
      state: {
        status: 'Saving memory...',
        threadTs: '1712345678.000100',
      },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'task-update',
        taskId: 'cmd-memory',
        title: 'Saving memory...',
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        title: command,
      }),
    );
  });

  it('renders shell-wrapped Codex commands without the shell prefix', async () => {
    const command = "/bin/zsh -lc 'git submodule status'";
    spawnMock.mockImplementation(
      () =>
        new FakeCodexProcess((_prompt, child) => {
          queueMicrotask(() => {
            writeJson(child, { type: 'thread.started', thread_id: 'codex-thread-1' });
            writeJson(child, { type: 'turn.started' });
            writeJson(child, {
              type: 'item.started',
              item: {
                id: 'cmd-shell',
                type: 'command_execution',
                command,
                status: 'in_progress',
              },
            });
            writeJson(child, {
              type: 'item.completed',
              item: {
                id: 'cmd-shell',
                type: 'command_execution',
                command,
                exit_code: 0,
                status: 'completed',
              },
            });
            writeJson(child, { type: 'turn.completed', usage: {} });
            child.stdout.end();
            child.stderr.end();
            child.emit('exit', 0, null);
          });
        }),
    );

    const events: AgentExecutionEvent[] = [];
    await new CodexCliExecutor(createLogger()).execute(createRequest(), createSink(events));

    expect(events).toContainEqual({
      type: 'activity-state',
      state: {
        status: 'git submodule status',
        threadTs: '1712345678.000100',
      },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'task-update',
        taskId: 'cmd-shell',
        title: 'git submodule status',
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        title: command,
      }),
    );
  });

  it('injects requested workspace skill markdown into the Codex prompt', () => {
    const workspacePath = mkdtempSync(path.join(tmpdir(), 'codex-skill-'));
    const skillDir = path.join(workspacePath, '.claude', 'skills', 'demo-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '# Demo Skill\n\nReply with DEMO_SKILL_OK.',
      'utf8',
    );

    const prompt = buildCodexPrompt(
      createRequest({
        mentionText: 'Invoke /demo-skill exactly once.',
        workspacePath,
        workspaceRepoId: 'repo-a',
      }),
    );

    expect(prompt).toContain('<codex_workspace_skills>');
    expect(prompt).toContain('## /demo-skill');
    expect(prompt).toContain('Reply with DEMO_SKILL_OK.');
  });

  it('persists Slack thread images as local Codex input files and references them in the prompt', () => {
    const request = createRequest({
      executionId: 'exec-image-input',
      threadContext: {
        channelId: 'C1',
        fileLoadFailures: [],
        imageLoadFailures: [],
        loadedFiles: [],
        loadedImages: [
          {
            authorId: 'U1',
            base64Data: Buffer.from('image-bytes').toString('base64'),
            fileId: 'F_IMG',
            fileName: 'red.png',
            messageIndex: 2,
            messageTs: '1712345678.000200',
            mimeType: 'image/png',
            slackUrl: 'https://files.slack.example/red.png',
          },
        ],
        messages: [
          {
            authorId: 'U1',
            files: [],
            images: [],
            rawText: '<@U_BOT> what color is this?',
            text: '<@U_BOT> what color is this?',
            threadTs: '1712345678.000100',
            ts: '1712345678.000200',
          },
        ],
        renderedPrompt: 'Slack thread context:',
        threadTs: '1712345678.000100',
      },
    });
    const runtimePaths = getCodexRuntimePaths(request);

    const prompt = buildCodexPrompt(request, runtimePaths);

    const imagePath = '/tmp/kagura/cache/images/01-1712345678.000200-F_IMG.png';
    expect(prompt).toContain('<codex_slack_image_inputs>');
    expect(prompt).toContain(`path=${imagePath}`);
    expect(prompt).not.toContain('This Codex CLI adapter currently does not forward Slack image');
    expect(readFileSync(imagePath, 'utf8')).toBe('image-bytes');
  });

  it('includes the shared Kagura host behavior in the Codex prompt', () => {
    const prompt = buildCodexPrompt(createRequest());

    expect(prompt).toContain('<system_instructions>');
    expect(prompt).toContain('Kagura is a Slack-native agent orchestration/runtime');
    expect(prompt).toContain('AskUserQuestion is disabled in this Slack host. Do not call it.');
    expect(prompt).toContain(
      'Ask for confirmation, approval, disambiguation, or choices in normal Slack-visible assistant text.',
    );
    expect(prompt).toContain(
      'When the user asks for a file deliverable, you must actually create and save the file locally, then use the available Kagura upload path; a text-only reply is not sufficient.',
    );
    expect(prompt).toContain('The direct upload_slack_file tool is not available');
    expect(prompt).toContain('To call set_channel_default_workspace');
    expect(prompt).toContain('including statements like "this channel\'s workspace is X"');
    expect(prompt).toContain(
      'session context applies to this turn, while the channel default is needed for future threads',
    );
    expect(prompt).toContain(
      'Do not save routine turn summaries, ephemeral status, transcript restatements',
    );
  });

  it('kills the Codex process and emits stopped on abort', async () => {
    let child: FakeCodexProcess | undefined;
    spawnMock.mockImplementation(() => {
      child = new FakeCodexProcess(() => {
        // Keep the process open until the abort signal arrives.
      });
      return child;
    });

    const controller = new AbortController();
    const events: AgentExecutionEvent[] = [];
    const execution = new CodexCliExecutor(createLogger()).execute(
      createRequest({ abortSignal: controller.signal }),
      createSink(events),
    );

    await Promise.resolve();
    controller.abort('user_stop');
    await execution;

    expect(child?.killed).toBe(true);
    expect(events).toContainEqual({
      type: 'lifecycle',
      phase: 'stopped',
      reason: 'user_stop',
    });
  });
});
