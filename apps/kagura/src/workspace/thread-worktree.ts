import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { AppLogger } from '~/logger/index.js';
import type { SessionRecord } from '~/session/types.js';

import { resolveWorkspaceBranch } from './resolver.js';
import type { ResolvedWorkspace } from './types.js';

export interface EnsureThreadWorkspaceInput {
  channelId: string;
  threadTs: string;
  workspace: ResolvedWorkspace;
}

export interface ThreadWorkspaceManager {
  ensureThreadWorkspace: (input: EnsureThreadWorkspaceInput) => ResolvedWorkspace;
  prune: (input: PruneThreadWorktreesInput) => PruneThreadWorktreesResult;
}

export interface GitThreadWorkspaceManagerOptions {
  worktreeRootDir: string;
}

export interface PruneThreadWorktreesInput {
  now?: Date | undefined;
  protectedWorkspacePaths: Iterable<string | undefined>;
  retentionMs: number;
}

export interface PruneThreadWorktreesResult {
  failed: number;
  removed: number;
  skippedProtected: number;
  skippedYoung: number;
}

export interface ThreadWorktreeCleanupSchedulerOptions {
  intervalMs: number;
  logger: AppLogger;
  manager: ThreadWorkspaceManager;
  retentionMs: number;
  sessionStore: { listAll: () => SessionRecord[] };
}

const LOCAL_ROOT_FILES_TO_COPY = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.e2e',
  'config.json',
] as const;

export class GitThreadWorkspaceManager implements ThreadWorkspaceManager {
  private readonly worktreeRootDir: string;

  constructor(options: GitThreadWorkspaceManagerOptions) {
    this.worktreeRootDir = path.resolve(options.worktreeRootDir);
  }

  ensureThreadWorkspace(input: EnsureThreadWorkspaceInput): ResolvedWorkspace {
    const { workspace } = input;
    const repoPath = workspace.repo.repoPath;
    const relativeWorkspacePath = normalizeRelativeWorkspacePath(
      path.relative(repoPath, workspace.workspacePath),
    );
    const worktreePath = this.resolveWorktreePath(workspace, input);
    const workspacePath = relativeWorkspacePath
      ? path.join(worktreePath, relativeWorkspacePath)
      : worktreePath;

    if (!isUsableGitWorktree(worktreePath)) {
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
      this.createWorktree(repoPath, worktreePath, this.resolveBranchName(workspace, input));
      copyLocalRootFiles(repoPath, worktreePath);
    }

    const workspaceBranch = resolveWorkspaceBranch(worktreePath);

    return {
      ...workspace,
      input: workspacePath,
      matchKind: 'path',
      ...(workspaceBranch ? { workspaceBranch } : {}),
      workspacePath,
    };
  }

  prune(input: PruneThreadWorktreesInput): PruneThreadWorktreesResult {
    const result: PruneThreadWorktreesResult = {
      failed: 0,
      removed: 0,
      skippedProtected: 0,
      skippedYoung: 0,
    };

    if (!fs.existsSync(this.worktreeRootDir)) {
      return result;
    }

    const nowMs = input.now?.getTime() ?? Date.now();
    const protectedWorkspacePaths = [...input.protectedWorkspacePaths]
      .filter((workspacePath): workspacePath is string => Boolean(workspacePath))
      .map((workspacePath) => path.resolve(workspacePath));

    for (const worktreePath of listManagedWorktreePaths(this.worktreeRootDir)) {
      if (isProtectedWorktree(worktreePath, protectedWorkspacePaths)) {
        result.skippedProtected += 1;
        continue;
      }

      const stat = safeStat(worktreePath);
      if (!stat) {
        continue;
      }

      if (nowMs - stat.mtimeMs < input.retentionMs) {
        result.skippedYoung += 1;
        continue;
      }

      try {
        removeManagedWorktree(worktreePath);
        result.removed += 1;
      } catch {
        result.failed += 1;
      }
    }

    return result;
  }

  private createWorktree(repoPath: string, worktreePath: string, branchName: string): void {
    const baseRef = resolveDefaultBaseRef(repoPath);
    const branchExists = gitSuccess(repoPath, [
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${branchName}`,
    ]);

    if (branchExists) {
      execFileSync('git', ['-C', repoPath, 'worktree', 'add', worktreePath, branchName], {
        stdio: 'ignore',
        timeout: 30_000,
      });
      return;
    }

    execFileSync(
      'git',
      ['-C', repoPath, 'worktree', 'add', '-b', branchName, worktreePath, baseRef],
      {
        stdio: 'ignore',
        timeout: 30_000,
      },
    );
  }

  private resolveWorktreePath(
    workspace: ResolvedWorkspace,
    input: EnsureThreadWorkspaceInput,
  ): string {
    return path.join(
      this.worktreeRootDir,
      sanitizePathPart(workspace.repo.id),
      `${sanitizePathPart(input.channelId)}-${sanitizePathPart(input.threadTs)}`,
    );
  }

  private resolveBranchName(
    workspace: ResolvedWorkspace,
    input: EnsureThreadWorkspaceInput,
  ): string {
    return [
      'kagura',
      sanitizeBranchPart(workspace.repo.id),
      `${sanitizeBranchPart(input.channelId)}-${sanitizeBranchPart(input.threadTs)}`,
    ].join('/');
  }
}

export class ThreadWorktreeCleanupScheduler {
  private running = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: ThreadWorktreeCleanupSchedulerOptions) {}

  start(): void {
    if (this.timer) {
      return;
    }

    const tick = (): void => {
      void this.runOnce();
    };
    this.timer = setInterval(tick, this.options.intervalMs);
    tick();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(): Promise<PruneThreadWorktreesResult | undefined> {
    if (this.running) {
      return undefined;
    }

    this.running = true;
    try {
      const sessions = this.options.sessionStore.listAll();
      const result = this.options.manager.prune({
        protectedWorkspacePaths: sessions.map((session) => session.workspacePath),
        retentionMs: this.options.retentionMs,
      });

      if (result.removed > 0 || result.failed > 0) {
        this.options.logger.info(
          'Thread worktree cleanup removed=%d failed=%d skippedProtected=%d skippedYoung=%d',
          result.removed,
          result.failed,
          result.skippedProtected,
          result.skippedYoung,
        );
      } else {
        this.options.logger.debug(
          'Thread worktree cleanup skippedProtected=%d skippedYoung=%d',
          result.skippedProtected,
          result.skippedYoung,
        );
      }

      return result;
    } catch (error) {
      this.options.logger.warn(
        'Thread worktree cleanup failed: %s',
        error instanceof Error ? error.message : String(error),
      );
      return undefined;
    } finally {
      this.running = false;
    }
  }
}

function resolveDefaultBaseRef(repoPath: string): string {
  const originHead = gitOutput(repoPath, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  if (originHead) {
    return originHead;
  }

  for (const candidate of ['origin/main', 'main', 'origin/master', 'master']) {
    const exists = gitSuccess(repoPath, ['show-ref', '--verify', '--quiet', refNameFor(candidate)]);
    if (exists) {
      return candidate;
    }
  }

  return 'HEAD';
}

function refNameFor(candidate: string): string {
  return candidate.startsWith('origin/') ? `refs/remotes/${candidate}` : `refs/heads/${candidate}`;
}

function normalizeRelativeWorkspacePath(relativePath: string): string | undefined {
  if (!relativePath || relativePath === '.') {
    return undefined;
  }
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return undefined;
  }
  return relativePath;
}

function isUsableGitWorktree(worktreePath: string): boolean {
  if (!fs.existsSync(worktreePath)) {
    return false;
  }

  return Boolean(gitOutput(worktreePath, ['rev-parse', '--show-toplevel']));
}

function listManagedWorktreePaths(worktreeRootDir: string): string[] {
  const result: string[] = [];
  for (const repoEntry of safeReadDir(worktreeRootDir)) {
    if (!repoEntry.isDirectory()) {
      continue;
    }

    const repoDir = path.join(worktreeRootDir, repoEntry.name);
    for (const worktreeEntry of safeReadDir(repoDir)) {
      if (!worktreeEntry.isDirectory()) {
        continue;
      }
      result.push(path.join(repoDir, worktreeEntry.name));
    }
  }

  return result;
}

function isProtectedWorktree(worktreePath: string, protectedWorkspacePaths: string[]): boolean {
  const candidate = path.resolve(worktreePath);
  return protectedWorkspacePaths.some(
    (workspacePath) => workspacePath === candidate || isSubPath(workspacePath, candidate),
  );
}

function isSubPath(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function removeManagedWorktree(worktreePath: string): void {
  if (isUsableGitWorktree(worktreePath)) {
    execFileSync('git', ['-C', worktreePath, 'worktree', 'remove', '--force', worktreePath], {
      stdio: 'ignore',
      timeout: 30_000,
    });
    return;
  }

  fs.rmSync(worktreePath, { force: true, recursive: true });
}

function safeReadDir(targetPath: string): fs.Dirent[] {
  try {
    return fs.readdirSync(targetPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeStat(targetPath: string): fs.Stats | undefined {
  try {
    return fs.statSync(targetPath);
  } catch {
    return undefined;
  }
}

function copyLocalRootFiles(sourceRepoPath: string, worktreePath: string): void {
  for (const fileName of LOCAL_ROOT_FILES_TO_COPY) {
    const source = path.join(sourceRepoPath, fileName);
    const target = path.join(worktreePath, fileName);
    if (!fs.existsSync(source) || fs.existsSync(target)) {
      continue;
    }
    const stat = fs.statSync(source);
    if (!stat.isFile()) {
      continue;
    }
    fs.copyFileSync(source, target);
  }
}

function sanitizePathPart(value: string): string {
  return value.replaceAll(/[^\w.-]+/g, '-').replaceAll(/^-+|-+$/g, '') || 'workspace';
}

function sanitizeBranchPart(value: string): string {
  return sanitizePathPart(value).slice(0, 80);
}

function gitOutput(cwd: string, args: string[]): string | undefined {
  try {
    const output = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    return output.trim() || undefined;
  } catch {
    return undefined;
  }
}

function gitSuccess(cwd: string, args: string[]): boolean {
  try {
    execFileSync('git', ['-C', cwd, ...args], {
      stdio: 'ignore',
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}
