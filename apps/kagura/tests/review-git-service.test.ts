import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { GitReviewService, resolveGitHead } from '~/review/git-review-service.js';
import { SqliteReviewSessionStore } from '~/review/sqlite-review-session-store.js';

import { createTestDatabase } from './fixtures/test-database.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe('GitReviewService', () => {
  it('lists changed files and renders tracked plus untracked diffs', () => {
    const workspacePath = createGitFixture();
    const baseHead = resolveGitHead(workspacePath);
    expect(baseHead).toBeTruthy();

    fs.writeFileSync(path.join(workspacePath, 'src/index.ts'), 'export const value = 2;\n');
    fs.writeFileSync(path.join(workspacePath, 'src/new.ts'), 'export const added = true;\n');

    const { db, sqlite } = createTestDatabase();
    const store = new SqliteReviewSessionStore(db);
    store.start({
      baseBranch: 'main',
      baseHead,
      channelId: 'C1',
      createdAt: new Date().toISOString(),
      executionId: 'exec-1',
      threadTs: '123.456',
      workspaceLabel: 'fixture',
      workspacePath,
      workspaceRepoId: 'fixture',
    });

    const service = new GitReviewService(store);
    const session = service.getSession('exec-1');
    expect(session?.changedFiles).toEqual([
      { path: 'src/index.ts', status: 'M', additions: 1, deletions: 1 },
      { path: 'src/new.ts', status: '??', additions: 1, deletions: 0 },
    ]);

    expect(service.listTree('exec-1')).toContainEqual({
      path: 'src/new.ts',
      status: '??',
      type: 'file',
    });

    const fullDiff = service.getDiff('exec-1') ?? '';
    expect(fullDiff).toContain('diff --git a/src/index.ts b/src/index.ts');
    expect(fullDiff).toContain('diff --git a/src/new.ts b/src/new.ts');
    expect(fullDiff).toContain('+export const added = true;');

    sqlite.close();
  });

  it('freezes completed review diffs as a snapshot', async () => {
    const workspacePath = createGitFixture();
    const baseHead = resolveGitHead(workspacePath);
    expect(baseHead).toBeTruthy();

    fs.writeFileSync(path.join(workspacePath, 'src/index.ts'), 'export const value = 2;\n');
    fs.writeFileSync(path.join(workspacePath, 'src/new.ts'), 'export const added = true;\n');

    const { db, sqlite } = createTestDatabase();
    const store = new SqliteReviewSessionStore(db);
    store.start({
      baseBranch: 'main',
      baseHead,
      channelId: 'C1',
      createdAt: new Date().toISOString(),
      executionId: 'exec-snapshot',
      threadTs: '123.456',
      workspaceLabel: 'fixture',
      workspacePath,
      workspaceRepoId: 'fixture',
    });

    const service = new GitReviewService(store);
    const before = service.getSession('exec-snapshot');
    expect(before).toBeTruthy();
    store.complete('exec-snapshot', 'completed', {
      changedFilesSnapshot: JSON.stringify(before?.changedFiles ?? []),
      diffSnapshot: service.getDiff('exec-snapshot') ?? '',
      head: resolveGitHead(workspacePath),
    });

    fs.writeFileSync(path.join(workspacePath, 'src/index.ts'), 'export const value = 3;\n');
    fs.writeFileSync(path.join(workspacePath, 'src/later.ts'), 'export const later = true;\n');

    const session = service.getSession('exec-snapshot');
    expect(session?.changedFiles).toEqual([
      { path: 'src/index.ts', status: 'M', additions: 1, deletions: 1 },
      { path: 'src/new.ts', status: '??', additions: 1, deletions: 0 },
    ]);

    const fullDiff = service.getDiff('exec-snapshot') ?? '';
    expect(fullDiff).toContain('export const value = 2;');
    expect(fullDiff).not.toContain('export const value = 3;');
    expect(fullDiff).not.toContain('src/later.ts');

    const fileDiff = service.getDiff('exec-snapshot', 'src/index.ts') ?? '';
    expect(fileDiff).toContain('diff --git a/src/index.ts b/src/index.ts');
    expect(fileDiff).not.toContain('src/new.ts');

    await expect(service.getFile('exec-snapshot', 'src/index.ts', 'head')).resolves.toBeUndefined();

    sqlite.close();
  });

  it('does not surface tracked status entries that have no diff against base', () => {
    const workspacePath = createGitFixture();
    const baseHead = resolveGitHead(workspacePath);
    expect(baseHead).toBeTruthy();

    fs.writeFileSync(path.join(workspacePath, 'src/index.ts'), 'export const value = 2;\n');
    git(workspacePath, ['add', 'src/index.ts']);
    fs.writeFileSync(path.join(workspacePath, 'src/index.ts'), 'export const value = 1;\n');

    const { db, sqlite } = createTestDatabase();
    const store = new SqliteReviewSessionStore(db);
    store.start({
      baseBranch: 'main',
      baseHead,
      channelId: 'C1',
      createdAt: new Date().toISOString(),
      executionId: 'exec-status',
      threadTs: '123.456',
      workspaceLabel: 'fixture',
      workspacePath,
      workspaceRepoId: 'fixture',
    });

    const service = new GitReviewService(store);
    expect(service.getSession('exec-status')?.changedFiles).toEqual([]);
    expect(service.getDiff('exec-status')).toBe('');

    sqlite.close();
  });

  it('returns base file via git show and head from working tree', async () => {
    const workspacePath = createGitFixture();
    const baseHead = resolveGitHead(workspacePath);

    fs.writeFileSync(path.join(workspacePath, 'src/index.ts'), 'export const value = 2;\n');

    const { db, sqlite } = createTestDatabase();
    const store = new SqliteReviewSessionStore(db);
    store.start({
      baseBranch: 'main',
      baseHead,
      channelId: 'C1',
      createdAt: new Date().toISOString(),
      executionId: 'exec-2',
      threadTs: '123.456',
      workspaceLabel: 'fixture',
      workspacePath,
      workspaceRepoId: 'fixture',
    });
    const service = new GitReviewService(store);

    const head = await service.getFile('exec-2', 'src/index.ts', 'head');
    expect(head).toMatchObject({ encoding: 'text', mediaType: 'text', path: 'src/index.ts' });
    expect(head?.content).toBe('export const value = 2;\n');

    const base = await service.getFile('exec-2', 'src/index.ts', 'base');
    expect(base).toMatchObject({ encoding: 'text', mediaType: 'text', path: 'src/index.ts' });
    expect(base?.content).toBe('export const value = 1;\n');

    const missingBase = await service.getFile('exec-2', 'src/new-untracked.ts', 'base');
    expect(missingBase).toBeUndefined();

    sqlite.close();
  });

  it('returns renderable images as base64 and suppresses generic binary content', async () => {
    const workspacePath = createGitFixture();
    const baseHead = resolveGitHead(workspacePath);
    expect(baseHead).toBeTruthy();

    fs.writeFileSync(
      path.join(workspacePath, 'src/image.png'),
      Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
    );
    fs.writeFileSync(path.join(workspacePath, 'src/blob.bin'), Buffer.from([0, 1, 2, 3, 4]));

    const { db, sqlite } = createTestDatabase();
    const store = new SqliteReviewSessionStore(db);
    store.start({
      baseBranch: 'main',
      baseHead,
      channelId: 'C1',
      createdAt: new Date().toISOString(),
      executionId: 'exec-binary',
      threadTs: '123.456',
      workspaceLabel: 'fixture',
      workspacePath,
      workspaceRepoId: 'fixture',
    });
    const service = new GitReviewService(store);

    expect(service.getSession('exec-binary')?.changedFiles).toEqual([
      { path: 'src/blob.bin', status: '??', additions: 0, deletions: 0 },
      { path: 'src/image.png', status: '??', additions: 0, deletions: 0 },
    ]);

    const fullDiff = service.getDiff('exec-binary') ?? '';
    expect(fullDiff).toContain('Binary files /dev/null and b/src/image.png differ');
    expect(fullDiff).toContain('Binary files /dev/null and b/src/blob.bin differ');

    await expect(service.getFile('exec-binary', 'src/image.png', 'head')).resolves.toMatchObject({
      encoding: 'base64',
      mediaType: 'image',
      mimeType: 'image/png',
      path: 'src/image.png',
    });
    const binary = await service.getFile('exec-binary', 'src/blob.bin', 'head');
    expect(binary).toEqual({ encoding: 'none', mediaType: 'binary', path: 'src/blob.bin' });

    sqlite.close();
  });
});

function createGitFixture(): string {
  const dir = createTempDir();
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/index.ts'), 'export const value = 1;\n');
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test User']);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'initial']);
  return dir;
}

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kagura-review-'));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_AUTHOR_NAME: 'Test User',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test User',
    },
    stdio: 'ignore',
  });
}
