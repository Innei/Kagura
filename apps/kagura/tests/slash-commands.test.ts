import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { AppLogger } from '~/logger/index.js';
import type { MemoryRecord, MemoryStore } from '~/memory/types.js';
import type { SessionRecord, SessionStore } from '~/session/types.js';
import { handleMemoryCommand } from '~/slack/commands/memory-command.js';
import { handleModelCommand } from '~/slack/commands/model-command.js';
import { handleSessionCommand } from '~/slack/commands/session-command.js';
import type { SlashCommandDependencies } from '~/slack/commands/types.js';
import { handleUsageCommand } from '~/slack/commands/usage-command.js';
import { handleVersionCommand } from '~/slack/commands/version-command.js';
import { handleWorkspaceCommand } from '~/slack/commands/workspace-command.js';
import type { ThreadExecutionRegistry } from '~/slack/execution/thread-execution-registry.js';
import { WorkspaceResolver } from '~/workspace/resolver.js';

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

function createMemorySessionStore(initial: SessionRecord[] = []): SessionStore {
  const records = new Map<string, SessionRecord>();
  for (const r of initial) {
    records.set(r.threadTs, r);
  }

  return {
    countAll: () => records.size,
    get: (threadTs) => {
      const existing = records.get(threadTs);
      return existing ? { ...existing } : undefined;
    },
    patch: (threadTs, patch) => {
      const existing = records.get(threadTs);
      if (!existing) return undefined;
      const next = { ...existing, ...patch, threadTs, updatedAt: new Date().toISOString() };
      records.set(threadTs, next);
      return { ...next };
    },
    upsert: (record) => {
      records.set(record.threadTs, { ...record });
      return { ...record };
    },
  };
}

function createMemoryStore(initial: MemoryRecord[] = []): MemoryStore {
  const records = [...initial];

  return {
    applyReconcileOps: () => ({ appliedOps: [] }),
    getDirtyBuckets: () => [],
    countAll: (repoId?: string) => {
      if (repoId) return records.filter((r) => r.repoId === repoId).length;
      return records.length;
    },
    countByCategory: (repoId, category) => {
      return records.filter(
        (r) => (repoId ? r.repoId === repoId : !r.repoId) && r.category === category,
      ).length;
    },
    delete: (id) => {
      const idx = records.findIndex((r) => r.id === id);
      if (idx >= 0) {
        records.splice(idx, 1);
        return true;
      }
      return false;
    },
    deleteAll: (repoId?: string | null) => {
      if (repoId === null) {
        const before = records.length;
        const toRemove = records.filter((r) => !r.repoId);
        for (const r of toRemove) {
          const idx = records.indexOf(r);
          if (idx >= 0) records.splice(idx, 1);
        }
        return before - records.length;
      }
      if (repoId) {
        const before = records.length;
        const toRemove = records.filter((r) => r.repoId === repoId);
        for (const r of toRemove) {
          const idx = records.indexOf(r);
          if (idx >= 0) records.splice(idx, 1);
        }
        return before - records.length;
      }
      const count = records.length;
      records.length = 0;
      return count;
    },
    listRecent: (repoId, limit = 10) =>
      records
        .filter((r) => (repoId ? r.repoId === repoId : !r.repoId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit),
    listForContext: (repoId, limits) => {
      const globalLimit = limits?.global ?? 5;
      const workspaceLimit = limits?.workspace ?? 10;

      const allGlobal = records
        .filter((r) => !r.repoId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const allWorkspace = repoId
        ? records
            .filter((r) => r.repoId === repoId)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        : [];

      const globalPrefs = allGlobal.filter((r) => r.category === 'preference');
      const workspacePrefs = allWorkspace.filter((r) => r.category === 'preference');
      const preferences = [...globalPrefs, ...workspacePrefs];
      const prefIds = new Set(preferences.map((p) => p.id));

      const global = allGlobal.filter((r) => !prefIds.has(r.id)).slice(0, globalLimit);
      const workspace = allWorkspace.filter((r) => !prefIds.has(r.id)).slice(0, workspaceLimit);

      return { global, workspace, preferences };
    },
    prune: (repoId) => {
      const before = records.length;
      const now = new Date().toISOString();
      const toRemove = records.filter(
        (r) => r.repoId === repoId && r.expiresAt && r.expiresAt <= now,
      );
      for (const r of toRemove) {
        const idx = records.indexOf(r);
        if (idx >= 0) records.splice(idx, 1);
      }
      return before - records.length;
    },
    pruneAll: () => 0,
    save: (input) => {
      const record: MemoryRecord = {
        ...input,
        scope: input.repoId ? 'workspace' : 'global',
        createdAt: new Date().toISOString(),
        id: `mem-${records.length + 1}`,
      };
      records.push(record);
      return record;
    },
    search: () => [],
  };
}

function createMockThreadExecutionRegistry(): ThreadExecutionRegistry {
  return {
    claimMessage: vi.fn(() => true),
    listActive: vi.fn(() => []),
    register: vi.fn(() => () => {}),
    stopAll: vi.fn(async () => ({ stopped: 0, failed: 0 })),
    stopByMessage: vi.fn(async () => ({ stopped: 0, failed: 0 })),
    trackMessage: vi.fn(),
  };
}

function createTestDeps(options?: {
  memoryRecords?: MemoryRecord[];
  repoRoot?: string;
  sessionRecords?: SessionRecord[];
  threadExecutionRegistry?: ThreadExecutionRegistry;
}): SlashCommandDependencies {
  const repoRoot = options?.repoRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-test-'));
  return {
    logger: createTestLogger(),
    memoryStore: createMemoryStore(options?.memoryRecords ?? []),
    providerRegistry: {
      defaultProviderId: 'claude-code',
      providerIds: ['claude-code', 'codex-cli', 'pi-agent'],
      has: (id: string) => ['claude-code', 'codex-cli', 'pi-agent'].includes(id),
      getExecutor: () => {
        throw new Error('not used in tests');
      },
      drain: async () => {},
    },
    sessionStore: createMemorySessionStore(options?.sessionRecords ?? []),
    threadExecutionRegistry:
      options?.threadExecutionRegistry ?? createMockThreadExecutionRegistry(),
    workspaceResolver: new WorkspaceResolver({ repoRootDir: repoRoot, scanDepth: 3 }),
  };
}

function makeSession(threadTs: string, overrides?: Partial<SessionRecord>): SessionRecord {
  return {
    channelId: 'C123',
    createdAt: '2026-04-01T00:00:00.000Z',
    rootMessageTs: threadTs,
    threadTs,
    updatedAt: '2026-04-01T01:00:00.000Z',
    ...overrides,
  };
}

function makeMemory(
  repoId: string,
  content: string,
  overrides?: Partial<MemoryRecord>,
): MemoryRecord {
  return {
    category: 'task_completed',
    content,
    createdAt: new Date().toISOString(),
    id: `mem-${Math.random().toString(36).slice(2)}`,
    repoId,
    scope: 'workspace',
    ...overrides,
  };
}

describe('handleUsageCommand', () => {
  it('returns session, memory, and repo counts', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
    fs.mkdirSync(path.join(repoRoot, 'my-repo', '.git'), { recursive: true });

    const deps = createTestDeps({
      repoRoot,
      sessionRecords: [makeSession('ts-1'), makeSession('ts-2')],
      memoryRecords: [makeMemory('my-repo', 'did stuff')],
    });

    const result = handleUsageCommand('', deps);

    expect(result.response_type).toBe('ephemeral');
    expect(result.text).toContain('Sessions:* 2');
    expect(result.text).toContain('Memories:* 1');
    expect(result.text).toContain('Repositories:* 1');
    expect(result.text).toContain('Uptime:');
  });

  it('handles empty state', () => {
    const deps = createTestDeps();
    const result = handleUsageCommand('', deps);

    expect(result.text).toContain('Sessions:* 0');
    expect(result.text).toContain('Memories:* 0');
  });
});

describe('handleWorkspaceCommand', () => {
  it('lists available workspaces', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-list-'));
    fs.mkdirSync(path.join(repoRoot, 'alpha', '.git'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'beta', '.git'), { recursive: true });

    const deps = createTestDeps({ repoRoot });
    const result = handleWorkspaceCommand('', deps);

    expect(result.response_type).toBe('ephemeral');
    expect(result.text).toContain('Available Workspaces');
    expect(result.text).toContain('alpha');
    expect(result.text).toContain('beta');
  });

  it('lists with explicit "list" subcommand', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-list2-'));
    fs.mkdirSync(path.join(repoRoot, 'gamma', '.git'), { recursive: true });

    const deps = createTestDeps({ repoRoot });
    const result = handleWorkspaceCommand('list', deps);

    expect(result.text).toContain('gamma');
  });

  it('shows details for a specific workspace', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-detail-'));
    fs.mkdirSync(path.join(repoRoot, 'my-project', '.git'), { recursive: true });

    const deps = createTestDeps({
      repoRoot,
      memoryRecords: [makeMemory('my-project', 'memory 1'), makeMemory('my-project', 'memory 2')],
    });
    const result = handleWorkspaceCommand('my-project', deps);

    expect(result.text).toContain('my-project');
    expect(result.text).toContain('Memories:* 2');
  });

  it('returns not found for unknown workspace', () => {
    const deps = createTestDeps();
    const result = handleWorkspaceCommand('nonexistent', deps);
    expect(result.text).toContain('No workspace found');
  });

  it('returns empty state message', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-empty-'));
    const deps = createTestDeps({ repoRoot });
    const result = handleWorkspaceCommand('', deps);
    expect(result.text).toContain('No repositories found');
  });
});

describe('handleModelCommand', () => {
  it('lists provider model defaults and current thread override', () => {
    const deps = createTestDeps({
      sessionRecords: [
        makeSession('ts-model', {
          agentModel: 'zai/glm-5.1',
          agentProvider: 'pi-agent',
        }),
      ],
    });

    const result = handleModelCommand('list', { ...deps, threadTs: 'ts-model' });

    expect(result.response_type).toBe('ephemeral');
    expect(result.text).toContain('Configured Model Defaults');
    expect(result.text).toContain('`pi-agent`');
    expect(result.text).toContain('`zai/glm-5.1`');
  });

  it('sets a thread model override and resets provider session id', () => {
    const deps = createTestDeps({
      sessionRecords: [
        makeSession('ts-model', {
          providerSessionId: 'provider-session-1',
        }),
      ],
    });

    const result = handleModelCommand('gpt-5.5', { ...deps, threadTs: 'ts-model' });

    expect(result.text).toContain('Model switched to *gpt-5.5*');
    expect(deps.sessionStore.get('ts-model')).toMatchObject({
      agentModel: 'gpt-5.5',
    });
    expect(deps.sessionStore.get('ts-model')?.providerSessionId).toBeUndefined();
  });

  it('resets a thread model override', () => {
    const deps = createTestDeps({
      sessionRecords: [
        makeSession('ts-model', {
          agentModel: 'claude-sonnet-4',
          providerSessionId: 'provider-session-1',
        }),
      ],
    });

    const result = handleModelCommand('reset', { ...deps, threadTs: 'ts-model' });

    expect(result.text).toContain('Model override cleared');
    expect(deps.sessionStore.get('ts-model')?.agentModel).toBeUndefined();
    expect(deps.sessionStore.get('ts-model')?.providerSessionId).toBeUndefined();
  });
});

describe('handleMemoryCommand', () => {
  it('shows help when no subcommand', () => {
    const deps = createTestDeps();
    const result = handleMemoryCommand('', deps);
    expect(result.text).toContain('Memory Commands');
    expect(result.text).toContain('/memory list');
  });

  it('lists recent memories for a repo', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-list-'));
    fs.mkdirSync(path.join(repoRoot, 'my-repo', '.git'), { recursive: true });

    const deps = createTestDeps({
      repoRoot,
      memoryRecords: [
        makeMemory('my-repo', 'Fixed the auth bug'),
        makeMemory('my-repo', 'Refactored the database layer'),
      ],
    });

    const result = handleMemoryCommand('list my-repo', deps);

    expect(result.response_type).toBe('ephemeral');
    expect(result.text).toContain('my-repo');
    expect(result.text).toContain('Fixed the auth bug');
    expect(result.text).toContain('Refactored the database layer');
  });

  it('counts memories for a repo', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-count-'));
    fs.mkdirSync(path.join(repoRoot, 'my-repo', '.git'), { recursive: true });

    const deps = createTestDeps({
      repoRoot,
      memoryRecords: [
        makeMemory('my-repo', 'one'),
        makeMemory('my-repo', 'two'),
        makeMemory('my-repo', 'three'),
      ],
    });

    const result = handleMemoryCommand('count my-repo', deps);
    expect(result.text).toContain('3');
  });

  it('returns no memories message', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-empty-'));
    fs.mkdirSync(path.join(repoRoot, 'empty-repo', '.git'), { recursive: true });

    const deps = createTestDeps({ repoRoot });
    const result = handleMemoryCommand('list empty-repo', deps);
    expect(result.text).toContain('No memories found');
  });

  it('returns error for unknown repo', () => {
    const deps = createTestDeps();
    const result = handleMemoryCommand('list nonexistent', deps);
    expect(result.text).toContain('No workspace found');
  });

  it('falls back to list when subcommand is a repo name', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-fallback-'));
    fs.mkdirSync(path.join(repoRoot, 'my-repo', '.git'), { recursive: true });

    const deps = createTestDeps({
      repoRoot,
      memoryRecords: [makeMemory('my-repo', 'some work')],
    });

    const result = handleMemoryCommand('my-repo', deps);
    expect(result.text).toContain('some work');
  });
});

describe('handleSessionCommand', () => {
  it('shows overview when no argument', () => {
    const deps = createTestDeps({
      sessionRecords: [makeSession('ts-1'), makeSession('ts-2'), makeSession('ts-3')],
    });

    const result = handleSessionCommand('', deps);

    expect(result.response_type).toBe('ephemeral');
    expect(result.text).toContain('Session Overview');
    expect(result.text).toContain('Total sessions:* 3');
  });

  it('shows session details for a specific thread_ts', () => {
    const deps = createTestDeps({
      sessionRecords: [
        makeSession('1712345678.000100', {
          workspaceLabel: 'my-project',
          workspacePath: '/repos/my-project',
          providerSessionId: 'claude-session-abcdef1234567890',
        }),
      ],
    });

    const result = handleSessionCommand('1712345678.000100', deps);

    expect(result.text).toContain('1712345678.000100');
    expect(result.text).toContain('my-project');
    expect(result.text).toContain('claude-session-a');
    expect(result.text).toContain('C123');
  });

  it('returns not found for unknown thread', () => {
    const deps = createTestDeps();
    const result = handleSessionCommand('unknown-ts', deps);
    expect(result.text).toContain('No session found');
  });

  it('shows session without workspace or provider session', () => {
    const deps = createTestDeps({
      sessionRecords: [makeSession('ts-bare')],
    });

    const result = handleSessionCommand('ts-bare', deps);
    expect(result.text).toContain('not set');
    expect(result.text).toContain('none');
  });
});

describe('handleVersionCommand', () => {
  it('returns ephemeral response with commit hash', () => {
    const result = handleVersionCommand();

    expect(result.response_type).toBe('ephemeral');
    expect(result.text).toContain('Bot Version');
    expect(result.text).toContain('Commit:');
  });

  it('includes a short hash prefix', () => {
    const result = handleVersionCommand();

    // The response should contain a short hash (7 chars) in backticks
    expect(result.text).toMatch(/`[\da-f]{7}`/);
  });

  it('includes commit date and deploy date', () => {
    const result = handleVersionCommand();

    expect(result.text).toContain('Commit Date:');
    expect(result.text).toContain('Deploy Date:');
    // Deploy date should be a valid ISO string
    const deployMatch = result.text.match(/Deploy Date:\*\s+(.+)/);
    expect(deployMatch).toBeTruthy();
    const deployDate = deployMatch?.[1];
    expect(deployDate).toBeTruthy();
    expect(new Date(deployDate!).getTime()).not.toBeNaN();
  });
});
