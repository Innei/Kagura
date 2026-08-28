import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { AgentExecutor } from '~/agent/types.js';
import type { SessionAnalyticsStore } from '~/analytics/types.js';
import type { AppLogger } from '~/logger/index.js';
import type { MemoryStore } from '~/memory/types.js';
import type { ReviewSessionStore } from '~/review/types.js';
import type { SessionRecord, SessionStore } from '~/session/types.js';
import type { SlackThreadContextLoader } from '~/slack/context/thread-context-loader.js';
import type { ThreadExecutionRegistry } from '~/slack/execution/thread-execution-registry.js';
import {
  acknowledgeAndLog,
  DEFAULT_CONVERSATION_STEPS,
  ensureThreadWorkspaceStep,
  executeAgent,
  handleStopKeywordStep,
  parseInlineModelDirectiveStep,
  prepareThreadContext,
  resolveSessionStep,
  resolveWorkspaceStep,
  runConversationPipeline,
  stopActiveExecutionsStep,
} from '~/slack/ingress/conversation-pipeline.js';
import type { ConversationPipelineContext, PipelineStep } from '~/slack/ingress/types.js';
import { SlackUserInputBridge } from '~/slack/interaction/user-input-bridge.js';
import type { SlackRenderer } from '~/slack/render/slack-renderer.js';
import type { SlackWebClientLike } from '~/slack/types.js';
import type { WorkspaceResolver } from '~/workspace/resolver.js';
import type { WorkspaceResolution } from '~/workspace/types.js';

describe('runConversationPipeline', () => {
  it('runs all steps in order', async () => {
    const calls: string[] = [];
    const steps: PipelineStep[] = [
      async () => {
        calls.push('a');
        return { action: 'continue' };
      },
      async () => {
        calls.push('b');
        return { action: 'continue' };
      },
      async () => {
        calls.push('c');
        return { action: 'continue' };
      },
    ];
    const ctx = {} as ConversationPipelineContext;

    await runConversationPipeline(ctx, steps);

    expect(calls).toEqual(['a', 'b', 'c']);
  });

  it('stops on early exit', async () => {
    const calls: string[] = [];
    const steps: PipelineStep[] = [
      async () => {
        calls.push('a');
        return { action: 'continue' };
      },
      async () => {
        calls.push('b');
        return { action: 'done', reason: 'ambiguous' };
      },
      async () => {
        calls.push('c');
        return { action: 'continue' };
      },
    ];
    const ctx = {} as ConversationPipelineContext;

    await runConversationPipeline(ctx, steps);

    expect(calls).toEqual(['a', 'b']);
  });

  it('propagates step errors', async () => {
    const steps: PipelineStep[] = [
      async () => {
        throw new Error('boom');
      },
    ];
    const ctx = {} as ConversationPipelineContext;

    await expect(runConversationPipeline(ctx, steps)).rejects.toThrow('boom');
  });
});

describe('DEFAULT_CONVERSATION_STEPS', () => {
  it('exports the expected number of steps', () => {
    expect(DEFAULT_CONVERSATION_STEPS).toHaveLength(9);
  });

  it('contains only functions', () => {
    for (const step of DEFAULT_CONVERSATION_STEPS) {
      expect(typeof step).toBe('function');
    }
  });

  it('runs handleStopKeywordStep before stopActiveExecutionsStep', () => {
    const stopKeywordIdx = DEFAULT_CONVERSATION_STEPS.indexOf(handleStopKeywordStep);
    const stopActiveIdx = DEFAULT_CONVERSATION_STEPS.indexOf(stopActiveExecutionsStep);
    expect(stopKeywordIdx).toBeGreaterThanOrEqual(0);
    expect(stopActiveIdx).toBeGreaterThan(stopKeywordIdx);
  });

  it('parses inline model directives before workspace resolution', () => {
    const inlineModelIdx = DEFAULT_CONVERSATION_STEPS.indexOf(parseInlineModelDirectiveStep);
    const workspaceIdx = DEFAULT_CONVERSATION_STEPS.indexOf(resolveWorkspaceStep);
    expect(inlineModelIdx).toBeGreaterThanOrEqual(0);
    expect(workspaceIdx).toBeGreaterThan(inlineModelIdx);
  });
});

function createMinimalPipelineContext(overrides?: {
  addAcknowledgementReaction?: boolean;
  sessionStoreRecords?: SessionRecord[];
  threadExecutionRegistry?: ConversationPipelineContext['deps']['threadExecutionRegistry'];
  workspaceResolverResult?: WorkspaceResolution;
}): ConversationPipelineContext {
  const records = new Map(
    (overrides?.sessionStoreRecords ?? []).map((r) => [r.threadTs, { ...r }]),
  );
  const sessionStore: SessionStore = {
    countAll: () => records.size,
    get: (ts) => {
      const r = records.get(ts);
      return r ? { ...r } : undefined;
    },
    patch: vi.fn((ts, patch) => {
      const existing = records.get(ts);
      if (!existing) return undefined;
      const next = { ...existing, ...patch, threadTs: ts, updatedAt: new Date().toISOString() };
      records.set(ts, next);
      return { ...next };
    }),
    upsert: vi.fn((record) => {
      records.set(record.threadTs, { ...record });
      return { ...record };
    }),
  };
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

  const unregister = vi.fn();
  const threadExecutionRegistry = {
    claimMessage: vi.fn().mockReturnValue(true),
    listActive: vi.fn().mockReturnValue([]),
    register: vi.fn().mockReturnValue(unregister),
    stopAll: vi.fn().mockResolvedValue({ failed: 0, stopped: 0 }),
    stopByMessage: vi.fn().mockResolvedValue({ failed: 0, stopped: 0 }),
    trackMessage: vi.fn(),
    ...overrides?.threadExecutionRegistry,
  } as ConversationPipelineContext['deps']['threadExecutionRegistry'];

  return {
    client: {
      assistant: { threads: { setStatus: vi.fn().mockResolvedValue({}) } },
      auth: { test: vi.fn().mockResolvedValue({ user_id: 'U_BOT' }) },
      chat: {
        delete: vi.fn().mockResolvedValue({}),
        postMessage: vi.fn().mockResolvedValue({ ts: 'msg-ts' }),
        update: vi.fn().mockResolvedValue({}),
      },
      conversations: { replies: vi.fn().mockResolvedValue({ messages: [] }) },
      files: { uploadV2: vi.fn().mockResolvedValue({ files: [{ id: 'F1' }] }) },
      reactions: {
        add: vi.fn().mockResolvedValue({}),
        remove: vi.fn().mockResolvedValue({}),
      },
      views: {
        open: vi.fn().mockResolvedValue({}),
        publish: vi.fn().mockResolvedValue({}),
      },
    } as unknown as SlackWebClientLike,
    deps: {
      analyticsStore: { upsert: vi.fn() } as unknown as SessionAnalyticsStore,
      claudeExecutor: {
        providerId: 'claude',
        execute: vi.fn().mockResolvedValue(undefined),
        drain: vi.fn(),
      } as unknown as AgentExecutor,
      logger: logger as unknown as AppLogger,
      memoryStore: {
        listForContext: vi.fn().mockReturnValue({ global: [], workspace: [], preferences: [] }),
      } as unknown as MemoryStore,
      renderer: {
        addAcknowledgementReaction: vi.fn().mockResolvedValue(undefined),
        removeAcknowledgementReaction: vi.fn().mockResolvedValue(undefined),
        addCompletionReaction: vi.fn().mockResolvedValue(undefined),
        clearUiState: vi.fn().mockResolvedValue(undefined),
        deleteThreadProgressMessage: vi.fn().mockResolvedValue(undefined),
        finalizeThreadProgressMessage: vi.fn().mockResolvedValue(undefined),
        postGeneratedFiles: vi.fn().mockResolvedValue([]),
        postGeneratedImages: vi.fn().mockResolvedValue([]),
        postReviewPanelLink: vi.fn().mockResolvedValue(undefined),
        postThreadReply: vi.fn().mockResolvedValue(undefined),
        setUiState: vi.fn().mockResolvedValue(undefined),
        showThinkingIndicator: vi.fn().mockResolvedValue(undefined),
        upsertThreadProgressMessage: vi.fn().mockResolvedValue(undefined),
      } as unknown as SlackRenderer,
      sessionStore,
      threadContextLoader: {
        loadThread: vi.fn().mockResolvedValue({
          channelId: 'C123',
          fileLoadFailures: [],
          loadedFiles: [],
          messages: [],
          renderedPrompt: '',
          threadTs: 'ts1',
          loadedImages: [],
          imageLoadFailures: [],
        }),
      } as unknown as SlackThreadContextLoader,
      threadExecutionRegistry,
      userInputBridge: new SlackUserInputBridge(logger as unknown as AppLogger),
      channelPreferenceStore: {
        get: vi.fn().mockReturnValue(undefined),
        upsert: vi.fn(),
      },
      workspaceResolver: {
        resolveFromText: vi
          .fn()
          .mockReturnValue(
            overrides?.workspaceResolverResult ?? { status: 'missing', query: '', reason: 'none' },
          ),
      } as unknown as WorkspaceResolver,
    },
    message: { channel: 'C123', team: 'T123', text: 'hello', ts: 'ts1', user: 'U123' },
    options: {
      addAcknowledgementReaction: overrides?.addAcknowledgementReaction ?? false,
      logLabel: 'test',
      rootMessageTs: 'ts1',
    },
    threadTs: 'ts1',
  };
}

function createGitWorktreeFixture(): { repoPath: string; worktreePath: string } {
  const repoPath = mkdtempSync(path.join(tmpdir(), 'pipeline-worktree-source-'));
  const worktreePath = mkdtempSync(path.join(tmpdir(), 'pipeline-worktree-target-'));
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
  execFileSync('git', ['worktree', 'add', '-b', 'feature/worktree', worktreePath], {
    cwd: repoPath,
    stdio: 'ignore',
  });
  return { repoPath, worktreePath };
}

describe('acknowledgeAndLog step', () => {
  it('sets existingSession on context from session store', async () => {
    const session = {
      channelId: 'C123',
      createdAt: '',
      rootMessageTs: 'ts1',
      threadTs: 'ts1',
      updatedAt: '',
    };
    const ctx = createMinimalPipelineContext({
      sessionStoreRecords: [session],
    });

    const result = await acknowledgeAndLog(ctx);

    expect(result.action).toBe('continue');
    expect(ctx.existingSession).toBeDefined();
    expect(ctx.existingSession?.threadTs).toBe('ts1');
  });

  it('adds acknowledgement reaction when configured', async () => {
    const ctx = createMinimalPipelineContext({ addAcknowledgementReaction: true });

    await acknowledgeAndLog(ctx);

    expect(ctx.deps.renderer.addAcknowledgementReaction).toHaveBeenCalledWith(
      ctx.client,
      'C123',
      'ts1',
    );
  });

  it('returns done for duplicate ingress messages before doing any further work', async () => {
    const ctx = createMinimalPipelineContext({ addAcknowledgementReaction: true });
    vi.mocked(ctx.deps.threadExecutionRegistry.claimMessage).mockReturnValue(false);

    const result = await acknowledgeAndLog(ctx);

    expect(result).toEqual({ action: 'done', reason: 'duplicate ingress message' });
    expect(ctx.deps.renderer.addAcknowledgementReaction).not.toHaveBeenCalled();
    expect(ctx.deps.logger.info).toHaveBeenCalledWith(
      'Skipping %s for thread %s because message %s was already claimed by ingress',
      'test',
      'ts1',
      'ts1',
    );
  });
});

describe('handleStopKeywordStep', () => {
  it('continues for non-stop text', async () => {
    const ctx = createMinimalPipelineContext();
    ctx.message.text = 'tell me a joke';

    const result = await handleStopKeywordStep(ctx);

    expect(result.action).toBe('continue');
    expect(ctx.deps.threadExecutionRegistry.stopAll).not.toHaveBeenCalled();
    expect(ctx.client.reactions.add).not.toHaveBeenCalled();
  });

  it('cancels and reacts when text is exactly "stop"', async () => {
    const ctx = createMinimalPipelineContext();
    ctx.message.text = 'stop';

    const result = await handleStopKeywordStep(ctx);

    expect(result).toEqual({ action: 'done', reason: 'user stop keyword' });
    expect(ctx.deps.threadExecutionRegistry.stopAll).toHaveBeenCalledWith('ts1', 'user_stop');
    expect(ctx.client.reactions.add).toHaveBeenCalledWith({
      channel: 'C123',
      name: 'octagonal_sign',
      timestamp: 'ts1',
    });
  });

  it('matches case-insensitively and strips trailing punctuation', async () => {
    const ctx = createMinimalPipelineContext();
    ctx.message.text = 'STOP!';

    const result = await handleStopKeywordStep(ctx);

    expect(result.action).toBe('done');
    expect(ctx.deps.threadExecutionRegistry.stopAll).toHaveBeenCalled();
  });

  it('matches "cancel" as a synonym', async () => {
    const ctx = createMinimalPipelineContext();
    ctx.message.text = 'cancel';

    const result = await handleStopKeywordStep(ctx);

    expect(result.action).toBe('done');
  });

  it('strips leading user mention before matching', async () => {
    const ctx = createMinimalPipelineContext();
    ctx.message.text = '<@U_BOT> stop';

    const result = await handleStopKeywordStep(ctx);

    expect(result.action).toBe('done');
  });

  it('ignores stop keyword embedded in longer text', async () => {
    const ctx = createMinimalPipelineContext();
    ctx.message.text = 'please stop the tests gracefully';

    const result = await handleStopKeywordStep(ctx);

    expect(result.action).toBe('continue');
    expect(ctx.deps.threadExecutionRegistry.stopAll).not.toHaveBeenCalled();
  });

  it('removes acknowledgement reaction when it was added', async () => {
    const ctx = createMinimalPipelineContext({ addAcknowledgementReaction: true });
    ctx.message.text = 'stop';

    await handleStopKeywordStep(ctx);

    expect(ctx.deps.renderer.removeAcknowledgementReaction).toHaveBeenCalledWith(
      ctx.client,
      'C123',
      'ts1',
    );
  });

  it('does not remove acknowledgement reaction when it was never added', async () => {
    const ctx = createMinimalPipelineContext({ addAcknowledgementReaction: false });
    ctx.message.text = 'stop';

    await handleStopKeywordStep(ctx);

    expect(ctx.deps.renderer.removeAcknowledgementReaction).not.toHaveBeenCalled();
  });

  it('swallows errors from reactions.add', async () => {
    const ctx = createMinimalPipelineContext();
    ctx.message.text = 'stop';
    vi.mocked(ctx.client.reactions.add).mockRejectedValueOnce(new Error('already_reacted'));

    const result = await handleStopKeywordStep(ctx);

    expect(result.action).toBe('done');
    expect(ctx.deps.logger.warn).toHaveBeenCalled();
  });
});

describe('stopActiveExecutionsStep', () => {
  it('continues when the thread is already idle', async () => {
    const ctx = createMinimalPipelineContext();

    const result = await stopActiveExecutionsStep(ctx);

    expect(result.action).toBe('continue');
    expect(ctx.deps.threadExecutionRegistry.stopAll).toHaveBeenCalledWith('ts1', 'superseded');
  });

  it('stops active executions and refreshes session', async () => {
    const session: SessionRecord = {
      channelId: 'C123',
      providerSessionId: 'saved-session-id',
      createdAt: '',
      rootMessageTs: 'ts1',
      threadTs: 'ts1',
      updatedAt: '',
    };
    const ctx = createMinimalPipelineContext({
      sessionStoreRecords: [session],
    });
    vi.mocked(ctx.deps.threadExecutionRegistry.listActive).mockReturnValue([
      {
        channelId: 'C123',
        executionId: 'e1',
        providerId: 'claude',
        startedAt: '',
        stop: vi.fn().mockResolvedValue(undefined),
        threadTs: 'ts1',
        userId: 'U123',
      },
    ]);
    vi.mocked(ctx.deps.threadExecutionRegistry.stopAll).mockResolvedValue({
      stopped: 1,
      failed: 0,
    });

    const result = await stopActiveExecutionsStep(ctx);

    expect(result.action).toBe('continue');
    expect(ctx.deps.threadExecutionRegistry.stopAll).toHaveBeenCalledWith('ts1', 'superseded');
    // existingSession should be refreshed from store
    expect(ctx.existingSession?.providerSessionId).toBe('saved-session-id');
  });

  it('waits for an in-flight stop to finish even when no executions are currently listed', async () => {
    const ctx = createMinimalPipelineContext();
    let unblockStop: () => void;
    const stopBlocked = new Promise<{ failed: number; stopped: number }>((resolve) => {
      unblockStop = () => {
        ctx.deps.sessionStore.upsert({
          channelId: 'C123',
          providerSessionId: 'persisted-after-drain',
          createdAt: '',
          rootMessageTs: 'ts1',
          threadTs: 'ts1',
          updatedAt: '',
        });
        resolve({ failed: 0, stopped: 1 });
      };
    });
    vi.mocked(ctx.deps.threadExecutionRegistry.listActive).mockReturnValue([]);
    vi.mocked(ctx.deps.threadExecutionRegistry.stopAll).mockReturnValue(stopBlocked);

    let resolved = false;
    const resultPromise = stopActiveExecutionsStep(ctx).then((result) => {
      resolved = true;
      return result;
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(resolved).toBe(false);

    unblockStop!();
    await expect(resultPromise).resolves.toEqual({ action: 'continue' });
    expect(ctx.existingSession?.providerSessionId).toBe('persisted-after-drain');
  });
});

describe('parseInlineModelDirectiveStep', () => {
  it('captures leading session directives and strips them from the trigger text', async () => {
    const ctx = createMinimalPipelineContext();
    ctx.message.text = '<@U_BOT> --model gpt-5.5 --effort high fix the flaky test';

    const result = await parseInlineModelDirectiveStep(ctx);

    expect(result.action).toBe('continue');
    expect(ctx.inlineModelOverride).toBe('gpt-5.5');
    expect(ctx.inlineReasoningEffortOverride).toBe('high');
    expect(ctx.message.text).toBe('<@U_BOT> fix the flaky test');
  });

  it('supports --model=value/model:value and --effort=value/effort:value forms', async () => {
    const equalsCtx = createMinimalPipelineContext();
    equalsCtx.message.text = '<@U_BOT> --model=openai/gpt-5 --effort=xhigh inspect this';

    await parseInlineModelDirectiveStep(equalsCtx);

    expect(equalsCtx.inlineModelOverride).toBe('openai/gpt-5');
    expect(equalsCtx.inlineReasoningEffortOverride).toBe('xhigh');
    expect(equalsCtx.message.text).toBe('<@U_BOT> inspect this');

    const colonCtx = createMinimalPipelineContext();
    colonCtx.message.text = '<@U_BOT> effort:low model:claude-sonnet-4 continue';

    await parseInlineModelDirectiveStep(colonCtx);

    expect(colonCtx.inlineModelOverride).toBe('claude-sonnet-4');
    expect(colonCtx.inlineReasoningEffortOverride).toBe('low');
    expect(colonCtx.message.text).toBe('<@U_BOT> continue');
  });

  it('does not apply inline directives once a provider session exists', async () => {
    const ctx = createMinimalPipelineContext({
      sessionStoreRecords: [
        {
          channelId: 'C123',
          createdAt: '',
          providerSessionId: 'provider-session',
          rootMessageTs: 'ts1',
          threadTs: 'ts1',
          updatedAt: '',
        },
      ],
    });
    ctx.existingSession = ctx.deps.sessionStore.get('ts1');
    ctx.message.text = '<@U_BOT> --model gpt-5.5 --effort high continue';

    await parseInlineModelDirectiveStep(ctx);

    expect(ctx.inlineModelOverride).toBeUndefined();
    expect(ctx.inlineReasoningEffortOverride).toBeUndefined();
    expect(ctx.message.text).toBe('<@U_BOT> --model gpt-5.5 --effort high continue');
  });

  it('applies inline directives when the message explicitly starts a new provider session', async () => {
    const ctx = createMinimalPipelineContext({
      sessionStoreRecords: [
        {
          channelId: 'C123',
          createdAt: '',
          providerSessionId: 'provider-session',
          rootMessageTs: 'ts1',
          threadTs: 'ts1',
          updatedAt: '',
        },
      ],
    });
    ctx.existingSession = ctx.deps.sessionStore.get('ts1');
    ctx.options.forceNewSession = true;
    ctx.message.text = '<@U_BOT> --model gpt-5.5 --effort medium start over';

    await parseInlineModelDirectiveStep(ctx);

    expect(ctx.inlineModelOverride).toBe('gpt-5.5');
    expect(ctx.inlineReasoningEffortOverride).toBe('medium');
    expect(ctx.message.text).toBe('<@U_BOT> start over');
  });
});

describe('resolveWorkspaceStep step', () => {
  it('returns done when workspace is ambiguous', async () => {
    const ctx = createMinimalPipelineContext({
      workspaceResolverResult: {
        status: 'ambiguous',
        query: 'my-app',
        reason: 'multiple',
        candidates: [
          {
            aliases: [],
            id: 'org1/my-app',
            label: 'org1/my-app',
            name: 'my-app',
            relativePath: 'org1/my-app',
            repoPath: '/tmp/1',
          },
          {
            aliases: [],
            id: 'org2/my-app',
            label: 'org2/my-app',
            name: 'my-app',
            relativePath: 'org2/my-app',
            repoPath: '/tmp/2',
          },
        ],
      },
    });

    const result = await resolveWorkspaceStep(ctx);

    expect(result.action).toBe('done');
    expect(ctx.client.chat.postMessage).toHaveBeenCalled();
  });

  it('sets workspace on context when unique', async () => {
    const workspace = {
      input: '/tmp/repo',
      matchKind: 'repo' as const,
      repo: {
        aliases: [],
        id: 'r1',
        label: 'r1',
        name: 'repo',
        relativePath: 'r1',
        repoPath: '/tmp/repo',
      },
      source: 'auto' as const,
      workspaceLabel: 'repo',
      workspacePath: '/tmp/repo',
    };
    const ctx = createMinimalPipelineContext({
      workspaceResolverResult: { status: 'unique', workspace },
    });

    const result = await resolveWorkspaceStep(ctx);

    expect(result.action).toBe('continue');
    expect(ctx.workspace).toEqual(workspace);
  });
});

describe('ensureThreadWorkspaceStep step', () => {
  it('replaces a new thread repo workspace with a dedicated thread worktree', async () => {
    const ctx = createMinimalPipelineContext();
    ctx.workspace = {
      input: '/tmp/repo',
      matchKind: 'repo',
      repo: {
        aliases: [],
        id: 'r1',
        label: 'r1',
        name: 'repo',
        relativePath: 'r1',
        repoPath: '/tmp/repo',
      },
      source: 'auto',
      workspaceLabel: 'repo',
      workspacePath: '/tmp/repo',
    };
    ctx.deps.threadWorkspaceManager = {
      ensureThreadWorkspace: vi.fn().mockReturnValue({
        ...ctx.workspace,
        workspaceBranch: 'kagura/r1/C123-ts1',
        workspacePath: '/tmp/worktrees/r1/C123-ts1',
      }),
      prune: vi.fn(),
    };

    const result = await ensureThreadWorkspaceStep(ctx);

    expect(result.action).toBe('continue');
    expect(ctx.deps.threadWorkspaceManager.ensureThreadWorkspace).toHaveBeenCalledWith({
      channelId: 'C123',
      threadTs: 'ts1',
      workspace: expect.objectContaining({ workspacePath: '/tmp/repo' }),
    });
    expect(ctx.workspace.workspacePath).toBe('/tmp/worktrees/r1/C123-ts1');
  });

  it('reuses an existing session worktree for resumed turns', async () => {
    const ctx = createMinimalPipelineContext({
      sessionStoreRecords: [
        {
          channelId: 'C123',
          createdAt: '',
          rootMessageTs: 'ts1',
          threadTs: 'ts1',
          updatedAt: '',
          workspaceLabel: 'repo',
          workspacePath: '/tmp/worktrees/r1/C123-ts1',
          workspaceRepoId: 'r1',
          workspaceRepoPath: '/tmp/repo',
        },
      ],
    });
    ctx.existingSession = ctx.deps.sessionStore.get('ts1');
    ctx.workspace = {
      input: '/tmp/worktrees/r1/C123-ts1',
      matchKind: 'path',
      repo: {
        aliases: [],
        id: 'r1',
        label: 'r1',
        name: 'repo',
        relativePath: 'r1',
        repoPath: '/tmp/repo',
      },
      source: 'auto',
      workspaceLabel: 'repo',
      workspacePath: '/tmp/worktrees/r1/C123-ts1',
    };
    ctx.deps.threadWorkspaceManager = {
      ensureThreadWorkspace: vi.fn(),
      prune: vi.fn(),
    };

    const result = await ensureThreadWorkspaceStep(ctx);

    expect(result.action).toBe('continue');
    expect(ctx.deps.threadWorkspaceManager.ensureThreadWorkspace).not.toHaveBeenCalled();
  });
});

describe('resolveSessionStep step', () => {
  it('sets resumeHandle on context', async () => {
    const ctx = createMinimalPipelineContext();

    const result = await resolveSessionStep(ctx);

    expect(result.action).toBe('continue');
    expect(ctx.resumeHandle).toBeUndefined();
  });

  it('persists an inline model override on the thread session', async () => {
    const ctx = createMinimalPipelineContext();
    ctx.inlineModelOverride = 'gpt-5.5';
    ctx.inlineReasoningEffortOverride = 'high';

    await resolveSessionStep(ctx);

    expect(ctx.existingSession?.agentModel).toBe('gpt-5.5');
    expect(ctx.existingSession?.agentReasoningEffort).toBe('high');
    expect(ctx.deps.sessionStore.patch).toHaveBeenCalledWith(
      'ts1',
      expect.objectContaining({ agentModel: 'gpt-5.5', agentReasoningEffort: 'high' }),
    );
  });
});

describe('prepareThreadContext step', () => {
  it('loads thread context and sets it on ctx', async () => {
    const ctx = createMinimalPipelineContext();

    const result = await prepareThreadContext(ctx);

    expect(result.action).toBe('continue');
    expect(ctx.threadContext).toBeDefined();
    expect(ctx.deps.threadContextLoader.loadThread).toHaveBeenCalled();
  });

  it('strips an applied inline model directive from the loaded current thread message', async () => {
    const ctx = createMinimalPipelineContext();
    ctx.inlineModelOverride = 'gpt-5.5';
    ctx.inlineReasoningEffortOverride = 'high';
    ctx.message.text = '<@U_BOT> fix the flaky test';
    vi.mocked(ctx.deps.threadContextLoader.loadThread).mockResolvedValueOnce({
      channelId: 'C123',
      fileLoadFailures: [],
      loadedFiles: [],
      messages: [
        {
          authorId: 'U123',
          files: [],
          images: [],
          rawText: '<@U_BOT> --model gpt-5.5 --effort high fix the flaky test',
          text: '<@U_BOT> --model gpt-5.5 --effort high fix the flaky test',
          threadTs: 'ts1',
          ts: 'ts1',
        },
      ],
      renderedPrompt: '',
      threadTs: 'ts1',
      loadedImages: [],
      imageLoadFailures: [],
    });

    await prepareThreadContext(ctx);

    expect(ctx.threadContext?.messages[0]?.text).toBe('<@U_BOT> fix the flaky test');
    expect(ctx.threadContext?.renderedPrompt).toContain('<@U_BOT> fix the flaky test');
    expect(ctx.threadContext?.renderedPrompt).not.toContain('--model');
    expect(ctx.threadContext?.renderedPrompt).not.toContain('--effort');
  });
});

describe('executeAgent step', () => {
  it('registers execution, passes abortSignal to executor, and unregisters in finally', async () => {
    const unregister = vi.fn();
    const register = vi.fn().mockReturnValue(unregister);
    const ctx = createMinimalPipelineContext({
      threadExecutionRegistry: {
        claimMessage: vi.fn().mockReturnValue(true),
        listActive: vi.fn(),
        register,
        stopAll: vi.fn(),
      } as unknown as ThreadExecutionRegistry,
    });
    await prepareThreadContext(ctx);

    await executeAgent(ctx);

    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'C123',
        executionId: expect.stringMatching(/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i),
        providerId: 'claude',
        startedAt: expect.any(String),
        threadTs: 'ts1',
        userId: 'U123',
      }),
    );
    const registered = register.mock.calls[0]![0] as { stop: () => Promise<void> };
    expect(typeof registered.stop).toBe('function');

    expect(ctx.deps.claudeExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: expect.any(AbortSignal),
      }),
      expect.anything(),
    );

    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it('updates review sessions when the provider switches to a worktree', async () => {
    const { repoPath, worktreePath } = createGitWorktreeFixture();
    const updateWorkspaceContext = vi.fn();
    const complete = vi.fn();
    const start = vi.fn();
    const ctx = createMinimalPipelineContext();
    ctx.workspace = {
      input: repoPath,
      matchKind: 'repo',
      repo: {
        aliases: [],
        id: 'innei-repo/slack-cc-bot',
        label: 'slack-cc-bot',
        name: 'slack-cc-bot',
        relativePath: 'slack-cc-bot',
        repoPath,
      },
      source: 'auto',
      workspaceBranch: 'main',
      workspaceLabel: 'slack-cc-bot',
      workspacePath: repoPath,
    };
    ctx.deps.reviewPanelBaseUrl = 'https://kagura.example';
    ctx.deps.reviewSessionStore = {
      complete,
      get: vi.fn(),
      start,
      updateWorkspaceContext,
    } as unknown as ReviewSessionStore;
    vi.mocked(ctx.deps.claudeExecutor.execute).mockImplementation(async (_request, sink) => {
      await sink.onEvent({
        type: 'workspace-context',
        workspaceLabel: 'slack-cc-bot-worktree',
        workspacePath: worktreePath,
        workspaceRepoId: 'innei-repo/slack-cc-bot',
      });
      writeFileSync(path.join(worktreePath, 'README.md'), 'fixture\nchanged in worktree\n');
      await sink.onEvent({ type: 'lifecycle', phase: 'completed' });
    });
    await prepareThreadContext(ctx);

    await executeAgent(ctx);

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceLabel: 'slack-cc-bot',
        workspacePath: repoPath,
      }),
    );
    expect(updateWorkspaceContext).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        baseBranch: 'feature/worktree',
        baseHead: execFileSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim(),
        workspaceLabel: 'slack-cc-bot-worktree',
        workspacePath: worktreePath,
        workspaceRepoId: 'innei-repo/slack-cc-bot',
      }),
    );
    expect(complete).toHaveBeenCalledWith(
      expect.any(String),
      'completed',
      expect.objectContaining({
        changedFilesSnapshot: JSON.stringify([
          { path: 'README.md', status: 'M', additions: 1, deletions: 0 },
        ]),
        diffSnapshot: expect.stringContaining('+changed in worktree'),
        head: execFileSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim(),
      }),
    );
  });

  it('removes execution from registry on stop before execute settles and only calls unregister once', async () => {
    const unregister = vi.fn();
    const register = vi.fn().mockReturnValue(unregister);
    const ctx = createMinimalPipelineContext({
      threadExecutionRegistry: {
        claimMessage: vi.fn().mockReturnValue(true),
        listActive: vi.fn(),
        register,
        stopAll: vi.fn(),
      } as unknown as ThreadExecutionRegistry,
    });
    await prepareThreadContext(ctx);

    vi.mocked(ctx.deps.claudeExecutor.execute).mockImplementation(async () => {
      const registered = register.mock.calls[0]?.[0] as { stop: () => Promise<void> };
      await registered.stop();
      expect(unregister).toHaveBeenCalledTimes(1);
    });

    await executeAgent(ctx);

    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it('idempotent stop during execute does not call unregister more than once', async () => {
    const unregister = vi.fn();
    const register = vi.fn().mockReturnValue(unregister);
    const ctx = createMinimalPipelineContext({
      threadExecutionRegistry: {
        claimMessage: vi.fn().mockReturnValue(true),
        listActive: vi.fn(),
        register,
        stopAll: vi.fn(),
      } as unknown as ThreadExecutionRegistry,
    });
    await prepareThreadContext(ctx);

    vi.mocked(ctx.deps.claudeExecutor.execute).mockImplementation(async () => {
      const registered = register.mock.calls[0]?.[0] as { stop: () => Promise<void> };
      await registered.stop();
      await registered.stop();
    });

    await executeAgent(ctx);

    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it('registers completionPromise that resolves after execution finishes', async () => {
    const unregister = vi.fn();
    const register = vi.fn().mockReturnValue(unregister);
    const ctx = createMinimalPipelineContext({
      threadExecutionRegistry: {
        claimMessage: vi.fn().mockReturnValue(true),
        listActive: vi.fn(),
        register,
        stopAll: vi.fn(),
        trackMessage: vi.fn(),
      } as unknown as ThreadExecutionRegistry,
    });
    await prepareThreadContext(ctx);

    let executorResolve: () => void;
    const executorBlock = new Promise<void>((resolve) => {
      executorResolve = resolve;
    });

    vi.mocked(ctx.deps.claudeExecutor.execute).mockImplementation(async (_req, _sink) => {
      await executorBlock;
    });

    // Start execution in background
    const executionPromise = executeAgent(ctx);

    // Wait for executor to be called
    await vi.waitFor(() => {
      expect(ctx.deps.claudeExecutor.execute).toHaveBeenCalledTimes(1);
    });

    // Get the registered execution with completionPromise
    const registered = register.mock.calls[0]?.[0] as {
      completionPromise: Promise<void>;
      stop: (reason?: string) => Promise<void>;
    };
    expect(registered.completionPromise).toBeInstanceOf(Promise);

    // completionPromise should not resolve until execution is done
    let completionResolved = false;
    const completionWatch = registered.completionPromise.then(() => {
      completionResolved = true;
    });

    // Give microtasks a chance to run
    await new Promise((r) => setTimeout(r, 10));
    expect(completionResolved).toBe(false);

    // Now let the executor finish
    executorResolve!();

    // Both should resolve
    await completionWatch;
    await executionPromise;
    expect(completionResolved).toBe(true);
  });

  it('stop callback passes abort reason to controller', async () => {
    const unregister = vi.fn();
    const register = vi.fn().mockReturnValue(unregister);
    const ctx = createMinimalPipelineContext({
      threadExecutionRegistry: {
        claimMessage: vi.fn().mockReturnValue(true),
        listActive: vi.fn(),
        register,
        stopAll: vi.fn(),
        trackMessage: vi.fn(),
      } as unknown as ThreadExecutionRegistry,
    });
    await prepareThreadContext(ctx);

    let capturedSignal: AbortSignal | undefined;
    vi.mocked(ctx.deps.claudeExecutor.execute).mockImplementation(async (req) => {
      capturedSignal = req.abortSignal;
    });

    await executeAgent(ctx);

    const registered = register.mock.calls[0]?.[0] as { stop: (reason?: string) => Promise<void> };
    await registered.stop('superseded');

    expect(capturedSignal?.aborted).toBe(true);
    expect(capturedSignal?.reason).toBe('superseded');
  });

  it('unregisters in finally when execute rejects', async () => {
    const unregister = vi.fn();
    const register = vi.fn().mockReturnValue(unregister);
    const ctx = createMinimalPipelineContext({
      threadExecutionRegistry: {
        listActive: vi.fn(),
        register,
        stopAll: vi.fn(),
      } as unknown as ThreadExecutionRegistry,
    });
    await prepareThreadContext(ctx);
    vi.mocked(ctx.deps.claudeExecutor.execute).mockRejectedValueOnce(new Error('exec failed'));

    await executeAgent(ctx);

    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it('triggers host memory ingestion after a completed assistant reply', async () => {
    const ctx = createMinimalPipelineContext({ addAcknowledgementReaction: true });
    ctx.options.executionId = 'exec-memory-1';
    const ingest = vi.fn().mockResolvedValue(undefined);
    ctx.deps.memoryIngestionService = { ingest } as never;
    await prepareThreadContext(ctx);

    vi.mocked(ctx.deps.claudeExecutor.execute).mockImplementation(async (_req, sink) => {
      await sink.onEvent({ type: 'assistant-message', text: 'Implemented the memory flow.' });
      await sink.onEvent({ type: 'lifecycle', phase: 'completed' });
    });

    await executeAgent(ctx);

    expect(ingest).toHaveBeenCalledWith({
      channelId: 'C123',
      executionId: 'exec-memory-1',
      finalAssistantText: 'Implemented the memory flow.',
      messageTs: 'ts1',
      providerId: 'claude',
      threadTs: 'ts1',
      userText: 'hello',
    });
  });

  it('passes the persisted inline model override and stripped mention text to the executor', async () => {
    const ctx = createMinimalPipelineContext({
      sessionStoreRecords: [
        {
          agentModel: 'gpt-5.5',
          agentReasoningEffort: 'high',
          channelId: 'C123',
          createdAt: '',
          rootMessageTs: 'ts1',
          threadTs: 'ts1',
          updatedAt: '',
        },
      ],
    });
    ctx.existingSession = ctx.deps.sessionStore.get('ts1');
    ctx.message.text = '<@U_BOT> fix the flaky test';
    await prepareThreadContext(ctx);

    await executeAgent(ctx);

    expect(ctx.deps.claudeExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        mentionText: '<@U_BOT> fix the flaky test',
        modelOverride: 'gpt-5.5',
        reasoningEffortOverride: 'high',
      }),
      expect.anything(),
    );
  });

  it('does not trigger host memory ingestion for failed executions', async () => {
    const ctx = createMinimalPipelineContext();
    ctx.options.executionId = 'exec-memory-failed';
    const ingest = vi.fn().mockResolvedValue(undefined);
    ctx.deps.memoryIngestionService = { ingest } as never;
    await prepareThreadContext(ctx);

    vi.mocked(ctx.deps.claudeExecutor.execute).mockImplementation(async (_req, sink) => {
      await sink.onEvent({ type: 'assistant-message', text: 'Partial reply.' });
      await sink.onEvent({ type: 'lifecycle', phase: 'failed', error: 'boom' });
    });

    await executeAgent(ctx);

    expect(ingest).not.toHaveBeenCalled();
  });
});
