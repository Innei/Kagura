import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { GitThreadWorkspaceManager } from '~/workspace/thread-worktree.js';
import type { ResolvedWorkspace } from '~/workspace/types.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function createGitRepo(): string {
  const repoPath = mkdtempSync(path.join(tmpdir(), 'thread-worktree-repo-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: repoPath,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoPath, stdio: 'ignore' });
  writeFileSync(path.join(repoPath, 'README.md'), 'main\n');
  writeFileSync(path.join(repoPath, '.env'), 'LOCAL_ONLY=1\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath, stdio: 'ignore' });
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'initial'], {
    cwd: repoPath,
    stdio: 'ignore',
  });
  return repoPath;
}

function createWorkspace(repoPath: string): ResolvedWorkspace {
  return {
    input: repoPath,
    matchKind: 'repo',
    repo: {
      aliases: [],
      id: 'org/my-repo',
      label: 'org/my-repo',
      name: 'my-repo',
      relativePath: 'org/my-repo',
      repoPath,
    },
    source: 'auto',
    workspaceBranch: 'main',
    workspaceLabel: 'org/my-repo',
    workspacePath: repoPath,
  };
}

describe('GitThreadWorkspaceManager', () => {
  it('creates a stable worktree and branch for a Slack thread', () => {
    const repoPath = createGitRepo();
    const worktreeRootDir = mkdtempSync(path.join(tmpdir(), 'thread-worktree-root-'));
    const manager = new GitThreadWorkspaceManager({ worktreeRootDir });

    const workspace = manager.ensureThreadWorkspace({
      channelId: 'C123',
      threadTs: '1781258358.885139',
      workspace: createWorkspace(repoPath),
    });

    expect(workspace.workspacePath).toBe(
      path.join(worktreeRootDir, 'org-my-repo', 'C123-1781258358.885139'),
    );
    expect(workspace.workspaceBranch).toBe('kagura/org-my-repo/C123-1781258358.885139');
    expect(git(workspace.workspacePath, ['branch', '--show-current'])).toBe(
      'kagura/org-my-repo/C123-1781258358.885139',
    );
    expect(readFileSync(path.join(workspace.workspacePath, 'README.md'), 'utf8')).toBe('main\n');
    expect(readFileSync(path.join(workspace.workspacePath, '.env'), 'utf8')).toBe('LOCAL_ONLY=1\n');

    const second = manager.ensureThreadWorkspace({
      channelId: 'C123',
      threadTs: '1781258358.885139',
      workspace: createWorkspace(repoPath),
    });
    expect(second.workspacePath).toBe(workspace.workspacePath);

    rmSync(worktreeRootDir, { force: true, recursive: true });
  });

  it('expands home directory in the configured worktree root', () => {
    const repoPath = createGitRepo();
    const relativeRoot = `~/kagura-thread-worktree-test-${Date.now()}`;
    const expectedRoot = path.join(os.homedir(), relativeRoot.slice(2));
    rmSync(expectedRoot, { force: true, recursive: true });
    const manager = new GitThreadWorkspaceManager({ worktreeRootDir: relativeRoot });

    const workspace = manager.ensureThreadWorkspace({
      channelId: 'CHOME',
      threadTs: 'home-thread',
      workspace: createWorkspace(repoPath),
    });

    expect(workspace.workspacePath).toBe(
      path.join(expectedRoot, 'org-my-repo', 'CHOME-home-thread'),
    );
    expect(workspace.workspacePath).not.toContain(`${process.cwd()}${path.sep}~`);

    rmSync(expectedRoot, { force: true, recursive: true });
  });

  it('preserves a resolved subdirectory inside the thread worktree', () => {
    const repoPath = createGitRepo();
    const packageDir = path.join(repoPath, 'apps', 'kagura');
    execFileSync('mkdir', ['-p', packageDir]);
    writeFileSync(path.join(packageDir, 'package.json'), '{}\n');
    execFileSync('git', ['add', 'apps/kagura/package.json'], { cwd: repoPath, stdio: 'ignore' });
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'add package'], {
      cwd: repoPath,
      stdio: 'ignore',
    });
    const worktreeRootDir = mkdtempSync(path.join(tmpdir(), 'thread-worktree-subdir-root-'));
    const manager = new GitThreadWorkspaceManager({ worktreeRootDir });
    const sourceWorkspace = {
      ...createWorkspace(repoPath),
      matchKind: 'path' as const,
      workspaceLabel: 'org/my-repo/apps/kagura',
      workspacePath: packageDir,
    };

    const workspace = manager.ensureThreadWorkspace({
      channelId: 'C999',
      threadTs: 'ts2',
      workspace: sourceWorkspace,
    });

    expect(workspace.workspacePath).toBe(
      path.join(worktreeRootDir, 'org-my-repo', 'C999-ts2', 'apps', 'kagura'),
    );
    expect(existsSync(path.join(workspace.workspacePath, 'package.json'))).toBe(true);

    rmSync(worktreeRootDir, { force: true, recursive: true });
  });

  it('prunes expired unprotected worktrees and keeps session-protected ones', () => {
    const repoPath = createGitRepo();
    const worktreeRootDir = mkdtempSync(path.join(tmpdir(), 'thread-worktree-prune-root-'));
    const manager = new GitThreadWorkspaceManager({ worktreeRootDir });
    const expired = manager.ensureThreadWorkspace({
      channelId: 'C111',
      threadTs: 'old-thread',
      workspace: createWorkspace(repoPath),
    });
    const protectedWorkspace = manager.ensureThreadWorkspace({
      channelId: 'C222',
      threadTs: 'active-thread',
      workspace: createWorkspace(repoPath),
    });
    const oldDate = new Date('2020-01-01T00:00:00Z');
    utimesSync(expired.workspacePath, oldDate, oldDate);
    utimesSync(protectedWorkspace.workspacePath, oldDate, oldDate);

    const result = manager.prune({
      now: new Date('2026-01-01T00:00:00Z'),
      protectedWorkspacePaths: [path.join(protectedWorkspace.workspacePath, 'apps', 'kagura')],
      retentionMs: 1,
    });

    expect(result).toEqual({
      failed: 0,
      removed: 1,
      skippedProtected: 1,
      skippedYoung: 0,
    });
    expect(existsSync(expired.workspacePath)).toBe(false);
    expect(existsSync(protectedWorkspace.workspacePath)).toBe(true);

    rmSync(worktreeRootDir, { force: true, recursive: true });
  });
});
