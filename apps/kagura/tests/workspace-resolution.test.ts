import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ChannelPreferenceStore } from '~/channel-preference/types.js';
import type { SessionRecord } from '~/session/types.js';
import {
  buildWorkspaceResolutionBlocks,
  resolveWorkspaceForConversation,
  WORKSPACE_PICKER_ACTION_ID,
} from '~/slack/ingress/workspace-resolution.js';
import type { WorkspaceResolver } from '~/workspace/resolver.js';
import type { ResolvedWorkspace, WorkspaceResolution } from '~/workspace/types.js';

function createMockChannelPreferenceStore(value: string | undefined): ChannelPreferenceStore {
  return {
    get: vi.fn().mockReturnValue(
      value
        ? {
            channelId: 'C123',
            createdAt: new Date().toISOString(),
            defaultWorkspaceInput: value,
            updatedAt: new Date().toISOString(),
          }
        : undefined,
    ),
    upsert: vi.fn(),
  };
}

function createMissingTempPath(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.rmSync(dir, { force: true, recursive: true });
  return dir;
}

describe('resolveWorkspaceForConversation', () => {
  it('returns the override when provided', () => {
    const override: ResolvedWorkspace = {
      input: '/tmp/repo',
      matchKind: 'repo',
      repo: {
        aliases: [],
        id: 'repo-1',
        label: 'repo-1',
        name: 'repo',
        relativePath: 'repo-1',
        repoPath: '/tmp/repo',
      },
      source: 'manual',
      workspaceLabel: 'repo',
      workspacePath: '/tmp/repo',
    };
    const resolver = { resolveFromText: vi.fn() } as unknown as WorkspaceResolver;
    const preferenceStore = createMockChannelPreferenceStore(undefined);

    const result = resolveWorkspaceForConversation(
      'some text',
      undefined,
      resolver,
      preferenceStore,
      'C123',
      override,
    );

    expect(result).toEqual({ status: 'unique', workspace: override });
    expect(resolver.resolveFromText).not.toHaveBeenCalled();
  });

  it('reconstructs workspace from existing session', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-resolution-session-'));
    const session: SessionRecord = {
      channelId: 'C123',
      createdAt: new Date().toISOString(),
      rootMessageTs: 'ts1',
      threadTs: 'ts1',
      updatedAt: new Date().toISOString(),
      workspaceLabel: 'my-repo',
      workspacePath: repoPath,
      workspaceRepoId: 'org/my-repo',
      workspaceRepoPath: repoPath,
    };
    const resolver = { resolveFromText: vi.fn() } as unknown as WorkspaceResolver;
    const preferenceStore = createMockChannelPreferenceStore(undefined);

    const result = resolveWorkspaceForConversation(
      'text',
      session,
      resolver,
      preferenceStore,
      'C123',
    );

    expect(result.status).toBe('unique');
    expect(result.status === 'unique' ? result.workspace.workspacePath : undefined).toBe(repoPath);
    expect(resolver.resolveFromText).not.toHaveBeenCalled();
  });

  it('falls back from a stale session worktree to the source repo path', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-resolution-repo-'));
    const session: SessionRecord = {
      channelId: 'C123',
      createdAt: new Date().toISOString(),
      rootMessageTs: 'ts1',
      threadTs: 'ts1',
      updatedAt: new Date().toISOString(),
      workspaceLabel: 'my-repo-pr-1',
      workspacePath: createMissingTempPath('missing-worktree-path-'),
      workspaceRepoId: 'org/my-repo',
      workspaceRepoPath: repoPath,
    };
    const resolver = { resolveFromText: vi.fn() } as unknown as WorkspaceResolver;
    const preferenceStore = createMockChannelPreferenceStore(undefined);

    const result = resolveWorkspaceForConversation(
      'text',
      session,
      resolver,
      preferenceStore,
      'C123',
    );

    expect(result.status).toBe('unique');
    expect(result.status === 'unique' ? result.workspace.workspacePath : undefined).toBe(repoPath);
    expect(result.status === 'unique' ? result.workspace.matchKind : undefined).toBe('repo');
    expect(resolver.resolveFromText).not.toHaveBeenCalled();
  });

  it('ignores a stale session workspace when neither the worktree nor source repo exists', () => {
    const preferenceResolution: WorkspaceResolution = {
      status: 'unique',
      workspace: {
        input: 'preferred-repo',
        matchKind: 'repo',
        repo: {
          aliases: [],
          id: 'preferred-repo',
          label: 'preferred-repo',
          name: 'preferred-repo',
          relativePath: 'preferred-repo',
          repoPath: '/tmp/preferred-repo',
        },
        source: 'manual',
        workspaceLabel: 'preferred-repo',
        workspacePath: '/tmp/preferred-repo',
      },
    };
    const session: SessionRecord = {
      channelId: 'C123',
      createdAt: new Date().toISOString(),
      rootMessageTs: 'ts1',
      threadTs: 'ts1',
      updatedAt: new Date().toISOString(),
      workspaceLabel: 'my-repo-pr-1',
      workspacePath: createMissingTempPath('missing-worktree-path-'),
      workspaceRepoId: 'org/my-repo',
      workspaceRepoPath: createMissingTempPath('missing-source-repo-path-'),
    };
    const resolver = {
      resolveFromText: vi.fn(),
      resolveManualInput: vi.fn().mockReturnValue(preferenceResolution),
    } as unknown as WorkspaceResolver;
    const preferenceStore = createMockChannelPreferenceStore('preferred-repo');

    const result = resolveWorkspaceForConversation(
      'text',
      session,
      resolver,
      preferenceStore,
      'C123',
    );

    expect(result).toEqual(preferenceResolution);
    expect(resolver.resolveManualInput).toHaveBeenCalledWith('preferred-repo', 'manual');
    expect(resolver.resolveFromText).not.toHaveBeenCalled();
  });

  it('falls back to resolver when no session workspace', () => {
    const missing: WorkspaceResolution = { status: 'missing', query: 'hello', reason: 'no match' };
    const resolver = {
      resolveFromText: vi.fn().mockReturnValue(missing),
    } as unknown as WorkspaceResolver;
    const preferenceStore = createMockChannelPreferenceStore(undefined);

    const result = resolveWorkspaceForConversation(
      'hello',
      undefined,
      resolver,
      preferenceStore,
      'C123',
    );

    expect(result).toEqual(missing);
    expect(resolver.resolveFromText).toHaveBeenCalledWith('hello', 'auto');
  });

  it('uses channel preference before resolver when preference exists and resolves', () => {
    const unique: WorkspaceResolution = {
      status: 'unique',
      workspace: {
        input: 'my-repo',
        matchKind: 'repo',
        repo: {
          aliases: [],
          id: 'my-repo',
          label: 'my-repo',
          name: 'my-repo',
          relativePath: 'my-repo',
          repoPath: '/tmp/my-repo',
        },
        source: 'manual',
        workspaceLabel: 'my-repo',
        workspacePath: '/tmp/my-repo',
      },
    };
    const resolver = {
      resolveFromText: vi.fn(),
      resolveManualInput: vi.fn().mockReturnValue(unique),
    } as unknown as WorkspaceResolver;
    const preferenceStore = createMockChannelPreferenceStore('my-repo');

    const result = resolveWorkspaceForConversation(
      'hello',
      undefined,
      resolver,
      preferenceStore,
      'C123',
    );

    expect(result).toEqual(unique);
    expect(preferenceStore.get).toHaveBeenCalledWith('C123');
    expect(resolver.resolveManualInput).toHaveBeenCalledWith('my-repo', 'manual');
    expect(resolver.resolveFromText).not.toHaveBeenCalled();
  });

  it('uses channel preference over auto-resolution when both could match', () => {
    const preferenceResolution: WorkspaceResolution = {
      status: 'unique',
      workspace: {
        input: 'my-repo',
        matchKind: 'repo',
        repo: {
          aliases: [],
          id: 'my-repo',
          label: 'my-repo',
          name: 'my-repo',
          relativePath: 'my-repo',
          repoPath: '/tmp/my-repo',
        },
        source: 'manual',
        workspaceLabel: 'my-repo',
        workspacePath: '/tmp/my-repo',
      },
    };
    const resolver = {
      resolveFromText: vi.fn(),
      resolveManualInput: vi.fn().mockReturnValue(preferenceResolution),
    } as unknown as WorkspaceResolver;
    const preferenceStore = createMockChannelPreferenceStore('my-repo');

    const result = resolveWorkspaceForConversation(
      'text-match',
      undefined,
      resolver,
      preferenceStore,
      'C123',
    );

    expect(result).toEqual(preferenceResolution);
    expect(resolver.resolveManualInput).toHaveBeenCalledWith('my-repo', 'manual');
    expect(resolver.resolveFromText).not.toHaveBeenCalled();
  });

  it('falls back to resolver when channel preference fails to resolve', () => {
    const missing: WorkspaceResolution = { status: 'missing', query: 'hello', reason: 'no match' };
    const resolver = {
      resolveFromText: vi.fn().mockReturnValue(missing),
      resolveManualInput: vi.fn().mockReturnValue(missing),
    } as unknown as WorkspaceResolver;
    const preferenceStore = createMockChannelPreferenceStore('unknown-repo');

    const result = resolveWorkspaceForConversation(
      'hello',
      undefined,
      resolver,
      preferenceStore,
      'C123',
    );

    expect(result).toEqual(missing);
    expect(resolver.resolveManualInput).toHaveBeenCalledWith('unknown-repo', 'manual');
    expect(resolver.resolveFromText).toHaveBeenCalledWith('hello', 'auto');
  });
});

describe('buildWorkspaceResolutionBlocks', () => {
  it('builds blocks with candidate labels and a picker button', () => {
    const resolution = {
      status: 'ambiguous' as const,
      query: 'my-app',
      reason: 'multiple matches',
      candidates: [
        {
          aliases: [],
          id: 'org1/my-app',
          label: 'org1/my-app',
          name: 'my-app',
          relativePath: 'org1/my-app',
          repoPath: '/tmp/org1/my-app',
        },
        {
          aliases: [],
          id: 'org2/my-app',
          label: 'org2/my-app',
          name: 'my-app',
          relativePath: 'org2/my-app',
          repoPath: '/tmp/org2/my-app',
        },
      ],
    };

    const { blocks, text } = buildWorkspaceResolutionBlocks(resolution, 'work on my-app');

    expect(text).toContain("couldn't tell which repository");
    expect(text).toContain('org1/my-app');
    expect(text).toContain('org2/my-app');
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toMatchObject({
      type: 'actions',
      block_id: 'workspace_picker',
    });
  });
});

describe('WORKSPACE_PICKER_ACTION_ID', () => {
  it('is a string constant', () => {
    expect(typeof WORKSPACE_PICKER_ACTION_ID).toBe('string');
  });
});
