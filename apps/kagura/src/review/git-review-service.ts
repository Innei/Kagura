import { execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { ReviewSessionRecord, ReviewSessionStore } from './types.js';

export interface ReviewChangedFile {
  additions?: number;
  deletions?: number;
  path: string;
  status: string;
}

export interface ReviewTreeEntry {
  path: string;
  status?: string | undefined;
  type: 'file';
}

export interface ReviewSessionDetails extends Omit<
  ReviewSessionRecord,
  'changedFilesSnapshot' | 'diffSnapshot'
> {
  changedFiles: ReviewChangedFile[];
}

export interface ReviewSessionSnapshot {
  changedFilesSnapshot: string;
  diffSnapshot: string;
}

export interface ReviewDiffPage {
  diff: string;
  hasMore: boolean;
  nextOffset: number;
}

export class GitReviewService {
  constructor(private readonly store: ReviewSessionStore) {}

  getSession(executionId: string): ReviewSessionDetails | undefined {
    const session = this.store.get(executionId);
    if (!session) return undefined;

    return {
      ...toPublicSession(session),
      changedFiles: readChangedFilesSnapshot(session) ?? getChangedFiles(session),
    };
  }

  listTree(executionId: string): ReviewTreeEntry[] | undefined {
    const session = this.store.get(executionId);
    if (!session) return undefined;

    const statusByPath = new Map(getChangedFiles(session).map((file) => [file.path, file.status]));
    const files = runGit(session.workspacePath, ['ls-files']).split('\n').filter(Boolean);
    for (const file of statusByPath.keys()) {
      if (!files.includes(file)) {
        files.push(file);
      }
    }

    return files
      .sort((left, right) => left.localeCompare(right))
      .map((file) => ({
        path: file,
        type: 'file' as const,
        ...(statusByPath.get(file) ? { status: statusByPath.get(file) } : {}),
      }));
  }

  getDiff(executionId: string, filePath?: string | undefined): string | undefined {
    const session = this.store.get(executionId);
    if (!session) return undefined;

    if (session.diffSnapshot !== undefined) {
      if (!filePath) return session.diffSnapshot;
      const relativePath = validateRelativeFilePath(filePath);
      return filterDiffSnapshotForPath(session.diffSnapshot, relativePath);
    }

    const args = ['diff', '--no-ext-diff', '--find-renames', session.baseHead ?? 'HEAD'];
    if (filePath) {
      const relativePath = validateRelativeFilePath(filePath);
      if (isUntracked(session, relativePath)) {
        return renderUntrackedFileDiff(session.workspacePath, relativePath);
      }
      args.push('--', relativePath);
    }

    const diff = runGit(session.workspacePath, args);
    if (filePath) {
      return diff;
    }

    const untrackedDiffs = getChangedFiles(session)
      .filter((file) => file.status === '??')
      .map((file) => renderUntrackedFileDiff(session.workspacePath, file.path))
      .filter(Boolean);

    return [diff, ...untrackedDiffs].filter(Boolean).join('\n');
  }

  getDiffPage(executionId: string, offset: number, limit: number): ReviewDiffPage | undefined {
    const session = this.store.get(executionId);
    if (!session) return undefined;

    const changedFiles = readChangedFilesSnapshot(session) ?? getChangedFiles(session);
    const start = Math.max(0, offset);
    const pageSize = Math.max(1, limit);
    const files = changedFiles.slice(start, start + pageSize);
    const chunks = files
      .map((file) => this.getDiff(executionId, file.path))
      .filter((diff): diff is string => Boolean(diff?.trim()));
    const nextOffset = start + files.length;

    return {
      diff: chunks.join('\n'),
      hasMore: nextOffset < changedFiles.length,
      nextOffset,
    };
  }

  async getFile(
    executionId: string,
    filePath: string,
    ref: 'base' | 'head' = 'head',
  ): Promise<
    | {
        content?: string | undefined;
        encoding: 'base64' | 'none' | 'text';
        mediaType: 'binary' | 'image' | 'text';
        mimeType?: string | undefined;
        path: string;
      }
    | undefined
  > {
    const session = this.store.get(executionId);
    if (!session) return undefined;

    const relativePath = validateRelativeFilePath(filePath);

    if (ref === 'base') {
      const base = session.baseHead ?? 'HEAD';
      const blob = readGitBlobBuffer(session.workspacePath, base, relativePath);
      if (blob === undefined) return undefined;
      return formatFilePayload(relativePath, blob);
    }

    if (session.diffSnapshot !== undefined && session.status !== 'running') {
      if (!session.head || session.head === session.baseHead) return undefined;
      const blob = readGitBlobBuffer(session.workspacePath, session.head, relativePath);
      if (blob === undefined) return undefined;
      return formatFilePayload(relativePath, blob);
    }

    const absolutePath = path.resolve(session.workspacePath, relativePath);
    const realWorkspace = await fs.realpath(session.workspacePath);
    const realTarget = await fs.realpath(absolutePath).catch(() => undefined);
    if (!realTarget || !isInside(realWorkspace, realTarget)) {
      return { content: '', encoding: 'text', mediaType: 'text', path: relativePath };
    }

    const stat = await fs.stat(realTarget);
    if (!stat.isFile()) {
      return { content: '', encoding: 'text', mediaType: 'text', path: relativePath };
    }

    const content = await fs.readFile(realTarget).catch(() => undefined);
    if (content === undefined) {
      return { encoding: 'none', mediaType: 'binary', path: relativePath };
    }
    return formatFilePayload(relativePath, content);
  }
}

export function createReviewSessionSnapshot(session: ReviewSessionRecord): ReviewSessionSnapshot {
  const changedFiles = getChangedFiles(session);
  const diff = buildDiff(session);
  return {
    changedFilesSnapshot: JSON.stringify(changedFiles),
    diffSnapshot: diff,
  };
}

export function resolveGitHead(workspacePath: string): string | undefined {
  return runGit(workspacePath, ['rev-parse', 'HEAD']) || undefined;
}

export function resolveGitBranch(workspacePath: string): string | undefined {
  return runGit(workspacePath, ['branch', '--show-current']) || undefined;
}

function toPublicSession(session: ReviewSessionRecord): Omit<ReviewSessionDetails, 'changedFiles'> {
  return {
    baseBranch: session.baseBranch,
    baseHead: session.baseHead,
    channelId: session.channelId,
    createdAt: session.createdAt,
    executionId: session.executionId,
    head: session.head,
    status: session.status,
    threadTs: session.threadTs,
    updatedAt: session.updatedAt,
    workspaceLabel: session.workspaceLabel,
    workspacePath: session.workspacePath,
    workspaceRepoId: session.workspaceRepoId,
  };
}

function getChangedFiles(session: ReviewSessionRecord): ReviewChangedFile[] {
  const base = session.baseHead ?? 'HEAD';
  const nameStatus = runGit(session.workspacePath, [
    'diff',
    '--name-status',
    '--find-renames',
    base,
  ])
    .split('\n')
    .filter(Boolean);
  const changed = nameStatus
    .map(parseNameStatus)
    .filter((entry): entry is ReviewChangedFile => Boolean(entry));
  const seen = new Set(changed.map((entry) => entry.path));

  for (const filePath of runGit(session.workspacePath, [
    'ls-files',
    '--others',
    '--exclude-standard',
  ]).split('\n')) {
    if (!filePath || seen.has(filePath)) continue;
    changed.push({ path: filePath, status: '??' });
    seen.add(filePath);
  }

  const numstat = parseNumstat(
    runGit(session.workspacePath, ['diff', '--numstat', '--find-renames', base]),
  );
  for (const file of changed) {
    const stat = numstat.get(file.path);
    if (stat) {
      file.additions = stat.additions;
      file.deletions = stat.deletions;
    } else if (file.status === '??') {
      file.additions = countUntrackedAdditions(session.workspacePath, file.path);
      file.deletions = 0;
    }
  }

  return changed.sort((left, right) => left.path.localeCompare(right.path));
}

function buildDiff(session: ReviewSessionRecord): string {
  const diff = runGit(session.workspacePath, [
    'diff',
    '--no-ext-diff',
    '--find-renames',
    session.baseHead ?? 'HEAD',
  ]);
  const untrackedDiffs = getChangedFiles(session)
    .filter((file) => file.status === '??')
    .map((file) => renderUntrackedFileDiff(session.workspacePath, file.path))
    .filter(Boolean);
  return [diff, ...untrackedDiffs].filter(Boolean).join('\n');
}

function readChangedFilesSnapshot(session: ReviewSessionRecord): ReviewChangedFile[] | undefined {
  if (session.changedFilesSnapshot === undefined) return undefined;
  try {
    const parsed = JSON.parse(session.changedFilesSnapshot);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter(isReviewChangedFile);
  } catch {
    return undefined;
  }
}

function isReviewChangedFile(value: unknown): value is ReviewChangedFile {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.path === 'string' && typeof record.status === 'string';
}

function filterDiffSnapshotForPath(diff: string, filePath: string): string {
  return splitGitDiff(diff)
    .filter((patch) => patchMatchesPath(patch, filePath))
    .join('\n');
}

function splitGitDiff(diff: string): string[] {
  const chunks = diff.split(/(?=^diff --git )/gm).filter((chunk) => chunk.trim());
  return chunks.length > 0 ? chunks : diff.trim() ? [diff] : [];
}

function patchMatchesPath(patch: string, filePath: string): boolean {
  const escaped = escapeRegExp(filePath);
  return (
    new RegExp(`^diff --git a/${escaped} b/`, 'm').test(patch) ||
    new RegExp(`^diff --git a/.+ b/${escaped}$`, 'm').test(patch) ||
    new RegExp(`^--- a/${escaped}$`, 'm').test(patch) ||
    new RegExp(`^\\+\\+\\+ b/${escaped}$`, 'm').test(patch)
  );
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[$()*+.?[\\\]^{|}]/g, '\\$&');
}

function parseNumstat(raw: string): Map<string, { additions: number; deletions: number }> {
  const result = new Map<string, { additions: number; deletions: number }>();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [addsRaw, delsRaw, ...rest] = line.split('\t');
    if (!addsRaw || !delsRaw || rest.length === 0) continue;
    const target = rest.at(-1);
    if (!target) continue;
    const additions = addsRaw === '-' ? 0 : Number.parseInt(addsRaw, 10);
    const deletions = delsRaw === '-' ? 0 : Number.parseInt(delsRaw, 10);
    if (Number.isNaN(additions) || Number.isNaN(deletions)) continue;
    result.set(target, { additions, deletions });
  }
  return result;
}

function countUntrackedAdditions(workspacePath: string, filePath: string): number {
  try {
    const absolutePath = path.resolve(workspacePath, filePath);
    if (!fsSync.statSync(absolutePath).isFile()) return 0;
    const buffer = fsSync.readFileSync(absolutePath);
    if (isBinaryBuffer(buffer)) return 0;
    const content = buffer.toString('utf8');
    if (!content) return 0;
    const lines = content.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines.length;
  } catch {
    return 0;
  }
}

function parseNameStatus(line: string): ReviewChangedFile | undefined {
  const parts = line.split('\t');
  const status = parts[0];
  const filePath = parts.at(-1);
  if (!status || !filePath) return undefined;
  return { path: filePath, status };
}

function isUntracked(session: ReviewSessionRecord, filePath: string): boolean {
  return getChangedFiles(session).some((file) => file.path === filePath && file.status === '??');
}

function renderUntrackedFileDiff(workspacePath: string, filePath: string): string {
  const absolutePath = path.resolve(workspacePath, filePath);
  let content: string;
  try {
    if (!fsSync.statSync(absolutePath).isFile()) return '';
    const buffer = fsSync.readFileSync(absolutePath);
    if (isBinaryBuffer(buffer)) {
      return `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\nBinary files /dev/null and b/${filePath} differ`;
    }
    content = buffer.toString('utf8');
  } catch {
    return `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\nBinary files /dev/null and b/${filePath} differ`;
  }

  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return [
    `diff --git a/${filePath} b/${filePath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join('\n');
}

function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trimEnd();
  } catch {
    return '';
  }
}

function readGitBlobBuffer(cwd: string, ref: string, filePath: string): Buffer | undefined {
  try {
    return execFileSync('git', ['-C', cwd, 'show', `${ref}:${filePath}`], {
      maxBuffer: 20 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

function formatFilePayload(
  filePath: string,
  buffer: Buffer,
): {
  content?: string | undefined;
  encoding: 'base64' | 'none' | 'text';
  mediaType: 'binary' | 'image' | 'text';
  mimeType?: string | undefined;
  path: string;
} {
  const mimeType = imageMimeType(filePath);
  if (mimeType) {
    return {
      content: buffer.toString('base64'),
      encoding: 'base64',
      mediaType: 'image',
      mimeType,
      path: filePath,
    };
  }
  if (isBinaryBuffer(buffer)) {
    return { encoding: 'none', mediaType: 'binary', path: filePath };
  }
  return { content: buffer.toString('utf8'), encoding: 'text', mediaType: 'text', path: filePath };
}

function imageMimeType(filePath: string): string | undefined {
  switch (path.extname(filePath).toLowerCase()) {
    case '.gif': {
      return 'image/gif';
    }
    case '.jpg':
    case '.jpeg': {
      return 'image/jpeg';
    }
    case '.png': {
      return 'image/png';
    }
    case '.webp': {
      return 'image/webp';
    }
    default: {
      return undefined;
    }
  }
}

function isBinaryBuffer(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  if (sample.includes(0)) return true;
  const decoded = sample.toString('utf8');
  return decoded.includes('\uFFFD');
}

function validateRelativeFilePath(filePath: string): string {
  const normalized = path.posix.normalize(filePath.replaceAll(path.sep, '/'));
  if (
    !normalized ||
    normalized === '.' ||
    normalized.startsWith('../') ||
    path.isAbsolute(filePath)
  ) {
    throw new Error('Invalid file path.');
  }
  return normalized;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}
