import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PiAgentExecutor } from '~/agent/providers/pi-agent/adapter.js';
import { buildPiAgentPrompt, getPiAgentRuntimePaths } from '~/agent/providers/pi-agent/prompt.js';
import type { AgentExecutionEvent, AgentExecutionRequest } from '~/agent/types.js';
import type {
  ChannelPreferenceRecord,
  ChannelPreferenceStore,
} from '~/channel-preference/types.js';
import type { AppLogger } from '~/logger/index.js';

const spawnMock = vi.hoisted(() => vi.fn());
const TEST_SESSION_DB_PATH = path.resolve(process.cwd(), './data/test-sessions.db');

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

class FakePiProcess extends EventEmitter {
  readonly stderr = new PassThrough();
  readonly stdout = new PassThrough();
  killed = false;
  readonly stdin: Writable;

  constructor(private readonly onPrompt: (prompt: string, child: FakePiProcess) => void) {
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

function writeJson(child: FakePiProcess, value: unknown): void {
  child.stdout.write(`${JSON.stringify(value)}\n`);
}

describe('PiAgentExecutor', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('passes the assembled Kagura prompt to pi -p and emits stdout as assistant message', async () => {
    const request = createRequest({ executionId: 'exec-pi' });
    const runtimePaths = getPiAgentRuntimePaths(request);

    spawnMock.mockImplementation(
      () =>
        new FakePiProcess((prompt, child) => {
          expect(prompt).toContain('<system_instructions>');
          expect(prompt).toContain(runtimePaths.channelOpsPath);
          queueMicrotask(() => {
            child.stdout.write('done from pi\n');
            child.stdout.end();
            child.stderr.end();
            child.emit('exit', 0, null);
          });
        }),
    );

    const events: AgentExecutionEvent[] = [];
    await new PiAgentExecutor(createLogger()).execute(request, createSink(events));

    expect(spawnMock).toHaveBeenCalledWith(
      'pi',
      ['-p', '--mode', 'json'],
      expect.objectContaining({
        cwd: runtimePaths.runtimeDir,
        env: expect.objectContaining({
          KAGURA_DB_PATH: TEST_SESSION_DB_PATH,
          PATH: expect.stringContaining(runtimePaths.runtimeDir),
        }),
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
    expect(events).toContainEqual({
      type: 'activity-state',
      state: {
        status: 'Pi Agent is thinking...',
        threadTs: '1712345678.000100',
      },
    });
    expect(events).toContainEqual({ type: 'assistant-message', text: 'done from pi' });
    expect(events.at(-1)).toEqual({ type: 'lifecycle', phase: 'completed' });
  });

  it('maps Pi JSONL text, tool, and usage events to Kagura events', async () => {
    const request = createRequest({ executionId: 'exec-pi-json' });

    spawnMock.mockImplementation(
      () =>
        new FakePiProcess((_prompt, child) => {
          queueMicrotask(() => {
            writeJson(child, { type: 'session', id: 'pi-session-1' });
            writeJson(child, { type: 'agent_start' });
            writeJson(child, { type: 'turn_start' });
            writeJson(child, {
              type: 'message_update',
              assistantMessageEvent: {
                type: 'toolcall_start',
                toolCall: { id: 'tool-1', name: 'ls', arguments: {} },
              },
            });
            writeJson(child, {
              type: 'tool_execution_start',
              toolCallId: 'tool-1',
              toolName: 'ls',
              args: {},
            });
            writeJson(child, {
              type: 'tool_execution_end',
              toolCallId: 'tool-1',
              toolName: 'ls',
              result: { content: [{ type: 'text', text: 'package.json' }] },
              isError: false,
            });
            writeJson(child, {
              type: 'turn_end',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'PI_JSON_OK' }],
                provider: 'zai',
                model: 'glm-5.1',
                usage: {
                  input: 10,
                  output: 5,
                  cacheRead: 20,
                  cacheWrite: 2,
                  cost: { total: 0.01 },
                },
              },
              toolResults: [],
            });
            writeJson(child, {
              type: 'agent_end',
              messages: [
                {
                  role: 'assistant',
                  content: [{ type: 'text', text: 'PI_JSON_OK' }],
                  provider: 'zai',
                  model: 'glm-5.1',
                  usage: {
                    input: 10,
                    output: 5,
                    cacheRead: 20,
                    cacheWrite: 2,
                    cost: { total: 0.01 },
                  },
                },
              ],
            });
            child.stdout.end();
            child.stderr.end();
            child.emit('exit', 0, null);
          });
        }),
    );

    const events: AgentExecutionEvent[] = [];
    await new PiAgentExecutor(createLogger()).execute(request, createSink(events));

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'task-update',
        taskId: 'tool-1',
        title: 'Listing files...',
        status: 'complete',
        details: 'package.json',
      }),
    );
    expect(events).toContainEqual({ type: 'assistant-message', text: 'PI_JSON_OK' });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'usage-info',
        usage: expect.objectContaining({
          costKnown: true,
          modelUsage: [
            expect.objectContaining({
              cacheCreationInputTokens: 2,
              cacheReadInputTokens: 20,
              costUSD: 0.01,
              inputTokens: 10,
              model: 'zai/glm-5.1',
              outputTokens: 5,
            }),
          ],
          totalCostUSD: 0.01,
        }),
      }),
    );
    expect(events.at(-1)).toEqual({ type: 'lifecycle', phase: 'completed' });
  });

  it('emits generated-files and generated-images for new Pi artifacts', async () => {
    const workspacePath = mkdtempSync(path.join(tmpdir(), 'pi-artifacts-'));
    const request = createRequest({ executionId: 'exec-pi-artifacts', workspacePath });
    const runtimePaths = getPiAgentRuntimePaths(request);
    const reportPath = path.join(runtimePaths.generatedArtifactsDir, 'report.txt');
    const imagePath = path.join(runtimePaths.generatedArtifactsDir, 'preview.png');

    spawnMock.mockImplementation(
      () =>
        new FakePiProcess((prompt, child) => {
          expect(prompt).toContain(runtimePaths.generatedArtifactsDir);
          queueMicrotask(() => {
            writeFileSync(reportPath, 'hello');
            writeFileSync(imagePath, Buffer.from('89504e470d0a1a0a', 'hex'));
            writeJson(child, {
              type: 'turn_end',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'artifacts ready' }],
                usage: {},
              },
              toolResults: [],
            });
            child.stdout.end();
            child.stderr.end();
            child.emit('exit', 0, null);
          });
        }),
    );

    const events: AgentExecutionEvent[] = [];
    await new PiAgentExecutor(createLogger()).execute(request, createSink(events));

    expect(events).toContainEqual({
      type: 'generated-files',
      files: [
        {
          fileName: 'report.txt',
          path: reportPath,
          providerFileId: 'pi-agent-local:report.txt',
        },
      ],
    });
    expect(events).toContainEqual({
      type: 'generated-images',
      files: [
        {
          fileName: 'preview.png',
          path: imagePath,
          providerFileId: 'pi-agent-local:preview.png',
        },
      ],
    });
    expect(existsSync(path.join(workspacePath, '.kagura'))).toBe(false);
  });

  it('includes stderr detail when pi exits non-zero', async () => {
    spawnMock.mockImplementation(
      () =>
        new FakePiProcess((_prompt, child) => {
          queueMicrotask(() => {
            child.stderr.write('pi auth failed\n');
            child.stdout.end();
            child.stderr.end();
            child.emit('exit', 1, null);
          });
        }),
    );

    const events: AgentExecutionEvent[] = [];
    await new PiAgentExecutor(createLogger()).execute(createRequest(), createSink(events));

    expect(events.at(-1)).toEqual({
      type: 'lifecycle',
      phase: 'failed',
      error: expect.stringContaining('pi auth failed'),
    });
  });

  it('applies set_channel_default_workspace JSONL operations after execution', async () => {
    const request = createRequest({ executionId: 'exec-channel-pref' });
    const { channelOpsPath } = getPiAgentRuntimePaths(request);
    const saved: ChannelPreferenceRecord[] = [];
    const channelPreferenceStore = createChannelPreferenceStore(saved);

    spawnMock.mockImplementation(
      () =>
        new FakePiProcess((_prompt, child) => {
          queueMicrotask(() => {
            writeFileSync(
              channelOpsPath,
              `${JSON.stringify({
                tool: 'set_channel_default_workspace',
                workspaceInput: 'LobeHub',
              })}\n`,
            );
            child.stdout.write('workspace saved\n');
            child.stdout.end();
            child.stderr.end();
            child.emit('exit', 0, null);
          });
        }),
    );

    await new PiAgentExecutor(createLogger(), channelPreferenceStore).execute(
      request,
      createSink([]),
    );

    expect(channelPreferenceStore.upsert).toHaveBeenCalledWith('C1', 'LobeHub');
    expect(saved).toHaveLength(1);
  });

  it('pi prompt mentions kagura-memory CLI for memory ops', () => {
    const prompt = buildPiAgentPrompt(createRequest(), getPiAgentRuntimePaths(createRequest()));
    expect(prompt).toContain(`KAGURA_DB_PATH='${TEST_SESSION_DB_PATH}' kagura-memory save`);
    expect(prompt).toContain(`KAGURA_DB_PATH='${TEST_SESSION_DB_PATH}' kagura-memory recall`);
  });
});
