import * as childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  ResolvedWorkspace,
  WorkspaceRepo,
  WorkspaceResolution,
  WorkspaceSource,
} from './types.js';

export interface WorkspaceResolverOptions {
  repoRootDir: string;
  scanDepth: number;
}

export class WorkspaceResolver {
  private readonly repoRootDir: string;
  private readonly scanDepth: number;

  constructor(options: WorkspaceResolverOptions) {
    this.repoRootDir = path.resolve(expandHomeDirectory(options.repoRootDir));
    this.scanDepth = Math.max(0, Math.trunc(options.scanDepth));
  }

  listRepos(): WorkspaceRepo[] {
    return this.scanRepos();
  }

  resolveFromText(text: string, source: WorkspaceSource = 'auto'): WorkspaceResolution {
    const query = text.trim();
    if (!query) {
      return {
        query,
        reason: 'Message text is empty.',
        status: 'missing',
      };
    }

    const repos = this.scanRepos();
    const candidates = new Map<string, { score: number; workspace: ResolvedWorkspace }>();
    const normalizedText = normalizeText(query);

    for (const workspace of this.extractAbsolutePathMatches(query, repos, source)) {
      rememberCandidate(candidates, workspace, 200);
    }

    for (const repo of repos) {
      for (const reference of [repo.relativePath, repo.name]) {
        const match = matchRepoReference(normalizedText, reference);
        if (!match) {
          continue;
        }

        const workspacePath = this.resolveWorkspacePathFromReference(repo, match.suffix);
        if (!workspacePath) {
          continue;
        }

        rememberCandidate(
          candidates,
          createResolvedWorkspace(
            repo,
            workspacePath,
            source,
            query,
            match.suffix ? 'path' : 'repo',
          ),
          reference === repo.relativePath ? 140 : 100,
        );
      }

      if (matchesWholeToken(normalizedText, repo.name)) {
        rememberCandidate(
          candidates,
          createResolvedWorkspace(repo, repo.repoPath, source, query, 'repo'),
          80,
        );
      }
    }

    return finalizeCandidates(query, candidates, repos);
  }

  resolveManualInput(input: string, source: WorkspaceSource = 'manual'): WorkspaceResolution {
    const query = input.trim();
    if (!query) {
      return {
        query,
        reason: 'Workspace input is empty.',
        status: 'missing',
      };
    }

    const repos = this.scanRepos();
    const expanded = expandHomeDirectory(query);
    const directPath = this.resolvePathInput(expanded, repos, source);
    if (directPath) {
      return {
        status: 'unique',
        workspace: directPath,
      };
    }

    const normalized = normalizeText(query);
    const repoMatches = repos.filter(
      (repo) =>
        repo.aliases.includes(normalized) ||
        normalizeText(repo.relativePath) === normalized ||
        normalizeText(repo.name) === normalized,
    );

    if (repoMatches.length === 1) {
      const repo = repoMatches[0];
      if (!repo) {
        return {
          query,
          reason: 'Repository match disappeared during resolution.',
          status: 'missing',
        };
      }

      return {
        status: 'unique',
        workspace: createResolvedWorkspace(repo, repo.repoPath, source, query, 'repo'),
      };
    }

    if (repoMatches.length > 1) {
      return {
        candidates: repoMatches,
        query,
        reason: 'Multiple repositories matched that alias.',
        status: 'ambiguous',
      };
    }

    return this.resolveFromText(query, source);
  }

  resolveRepoId(repoId: string, source: WorkspaceSource = 'manual'): WorkspaceResolution {
    const repos = this.scanRepos();
    const repo = repos.find((item) => item.id === repoId);
    if (!repo) {
      return {
        query: repoId,
        reason: 'Selected repository is no longer available.',
        status: 'missing',
      };
    }

    return {
      status: 'unique',
      workspace: createResolvedWorkspace(repo, repo.repoPath, source, repoId, 'repo'),
    };
  }

  private scanRepos(): WorkspaceRepo[] {
    if (!fs.existsSync(this.repoRootDir)) {
      return [];
    }

    const repos = new Map<string, WorkspaceRepo>();

    const walk = (targetDir: string, depth: number): void => {
      if (!fs.existsSync(targetDir)) {
        return;
      }

      if (this.isGitRepo(targetDir)) {
        const repo = this.createRepo(targetDir);
        repos.set(repo.id, repo);
        return;
      }

      if (depth >= this.scanDepth) {
        return;
      }

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(targetDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        if (entry.name.startsWith('.')) {
          continue;
        }

        walk(path.join(targetDir, entry.name), depth + 1);
      }
    };

    walk(this.repoRootDir, 0);

    return [...repos.values()].sort((left, right) => left.label.localeCompare(right.label));
  }

  private createRepo(repoPath: string): WorkspaceRepo {
    const relativePath = normalizeRelativePath(path.relative(this.repoRootDir, repoPath));
    const name = path.basename(repoPath);
    const label = relativePath || name;
    const aliases = [
      ...new Set(
        [name, relativePath, normalizeAlias(relativePath), normalizeAlias(name)].filter(Boolean),
      ),
    ];

    return {
      aliases,
      id: label,
      label,
      name,
      repoPath,
      relativePath: relativePath || name,
    };
  }

  private isGitRepo(targetDir: string): boolean {
    const gitPath = path.join(targetDir, '.git');
    return fs.existsSync(gitPath);
  }

  private extractAbsolutePathMatches(
    text: string,
    repos: WorkspaceRepo[],
    source: WorkspaceSource,
  ): ResolvedWorkspace[] {
    const matches = new Map<string, ResolvedWorkspace>();
    const pathTokens = text.match(/(?:~\/|\/)[^\s"'<>`]+/g) ?? [];

    for (const token of pathTokens) {
      const workspace = this.resolvePathInput(expandHomeDirectory(token), repos, source, text);
      if (!workspace) {
        continue;
      }

      matches.set(workspace.workspacePath, workspace);
    }

    return [...matches.values()];
  }

  private resolvePathInput(
    input: string,
    repos: WorkspaceRepo[],
    source: WorkspaceSource,
    originalInput = input,
  ): ResolvedWorkspace | undefined {
    const absolutePath = path.isAbsolute(input)
      ? path.normalize(input)
      : path.resolve(this.repoRootDir, input);
    const existingDir = findExistingDirectory(absolutePath);
    if (!existingDir || !isSubPath(existingDir, this.repoRootDir)) {
      return undefined;
    }

    const repo = repos.find((candidate) => isSubPath(existingDir, candidate.repoPath));
    if (!repo) {
      return undefined;
    }

    return createResolvedWorkspace(
      repo,
      existingDir,
      source,
      originalInput,
      existingDir === repo.repoPath ? 'repo' : 'path',
    );
  }

  private resolveWorkspacePathFromReference(
    repo: WorkspaceRepo,
    suffix: string | undefined,
  ): string | undefined {
    if (!suffix) {
      return repo.repoPath;
    }

    const sanitized = suffix.replace(/^\/+/, '').trim();
    if (!sanitized) {
      return repo.repoPath;
    }

    const candidate = path.resolve(repo.repoPath, sanitized);
    if (!isSubPath(candidate, repo.repoPath)) {
      return undefined;
    }

    const existingDir = findExistingDirectory(candidate);
    if (!existingDir || !isSubPath(existingDir, repo.repoPath)) {
      return undefined;
    }

    return existingDir;
  }
}

function createResolvedWorkspace(
  repo: WorkspaceRepo,
  workspacePath: string,
  source: WorkspaceSource,
  input: string,
  matchKind: 'path' | 'repo',
): ResolvedWorkspace {
  const relativeWorkspace = normalizeRelativePath(path.relative(repo.repoPath, workspacePath));
  const workspaceLabel = relativeWorkspace ? `${repo.label}/${relativeWorkspace}` : repo.label;
  const workspaceBranch = resolveWorkspaceBranch(workspacePath);

  return {
    input,
    matchKind,
    repo,
    source,
    ...(workspaceBranch ? { workspaceBranch } : {}),
    workspaceLabel,
    workspacePath,
  };
}

export function resolveWorkspaceBranch(workspacePath: string): string | undefined {
  try {
    const branch = childProcess
      .execFileSync('git', ['-C', workspacePath, 'branch', '--show-current'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1500,
        windowsHide: true,
      })
      .trim();

    return branch || undefined;
  } catch {
    return undefined;
  }
}

const WORKSPACE_METADATA_CACHE_TTL_MS = 5_000;
const workspaceMetadataCache = new Map<string, WorkspaceMetadataCacheEntry>();

interface WorkspaceMetadataCacheEntry {
  expiresAt: number;
  metadata: Pick<
    ResolvedWorkspace,
    'workspaceBranch' | 'workspacePullRequestNumber' | 'workspacePullRequestUrl'
  >;
}

export function enrichResolvedWorkspace(workspace: ResolvedWorkspace): ResolvedWorkspace {
  const metadata = resolveWorkspaceDisplayMetadata(workspace.workspacePath);

  return {
    ...workspace,
    ...metadata,
  };
}

export function resolveWorkspaceDisplayMetadata(
  workspacePath: string,
): Pick<
  ResolvedWorkspace,
  'workspaceBranch' | 'workspacePullRequestNumber' | 'workspacePullRequestUrl'
> {
  const cacheKey = workspacePath;
  const now = Date.now();
  const cached = workspaceMetadataCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.metadata;
  }

  const workspaceBranch = resolveWorkspaceBranch(workspacePath);
  const pullRequest = resolveWorkspacePullRequest(workspacePath, workspaceBranch);
  const metadata: WorkspaceMetadataCacheEntry['metadata'] = {
    ...(workspaceBranch ? { workspaceBranch } : {}),
    ...(pullRequest?.number ? { workspacePullRequestNumber: pullRequest.number } : {}),
    ...(pullRequest?.url ? { workspacePullRequestUrl: pullRequest.url } : {}),
  };

  workspaceMetadataCache.set(cacheKey, {
    expiresAt: now + WORKSPACE_METADATA_CACHE_TTL_MS,
    metadata,
  });

  return metadata;
}

function resolveWorkspacePullRequest(
  workspacePath: string,
  workspaceBranch: string | undefined,
): { number?: number; url?: string } | undefined {
  if (!workspaceBranch || workspaceBranch === 'main' || workspaceBranch === 'master') {
    return undefined;
  }

  try {
    const raw = childProcess.execFileSync(
      'gh',
      [
        'pr',
        'list',
        '--head',
        workspaceBranch,
        '--state',
        'open',
        '--json',
        'number,url',
        '--limit',
        '1',
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        cwd: workspacePath,
        timeout: 2500,
        windowsHide: true,
      },
    );
    const parsed = JSON.parse(raw) as Array<{ number?: number; url?: string }>;
    const first = parsed[0];
    if (!first?.url) {
      return undefined;
    }

    return {
      ...(typeof first.number === 'number' ? { number: first.number } : {}),
      url: first.url,
    };
  } catch {
    return undefined;
  }
}

function finalizeCandidates(
  query: string,
  candidates: Map<string, { score: number; workspace: ResolvedWorkspace }>,
  repos: WorkspaceRepo[],
): WorkspaceResolution {
  const resolved = [...candidates.values()].sort(
    (left, right) =>
      right.score - left.score ||
      left.workspace.workspaceLabel.localeCompare(right.workspace.workspaceLabel),
  );

  if (resolved.length === 1) {
    const firstResolved = resolved[0];
    if (!firstResolved) {
      return {
        query,
        reason: 'No repository reference was detected in the message.',
        status: 'missing',
      };
    }

    return {
      status: 'unique',
      workspace: firstResolved.workspace,
    };
  }

  if (resolved.length > 1) {
    const firstResolved = resolved[0];
    if (!firstResolved) {
      return {
        query,
        reason: 'No repository reference was detected in the message.',
        status: 'missing',
      };
    }

    const topScore = firstResolved.score;
    const topCandidates = resolved.filter((candidate) => candidate.score === topScore);

    if (topCandidates.length === 1) {
      const topCandidate = topCandidates[0];
      if (!topCandidate) {
        return {
          query,
          reason: 'No repository reference was detected in the message.',
          status: 'missing',
        };
      }

      return {
        status: 'unique',
        workspace: topCandidate.workspace,
      };
    }

    const topRepoIds = new Set(topCandidates.map((candidate) => candidate.workspace.repo.id));
    if (topRepoIds.size === 1) {
      const mostSpecific = [...topCandidates].sort(
        (left, right) =>
          right.workspace.workspacePath.length - left.workspace.workspacePath.length ||
          left.workspace.workspaceLabel.localeCompare(right.workspace.workspaceLabel),
      )[0];
      if (mostSpecific) {
        return {
          status: 'unique',
          workspace: mostSpecific.workspace,
        };
      }
    }

    return {
      candidates: topCandidates.map((candidate) => candidate.workspace.repo),
      query,
      reason: 'Multiple repositories matched the request.',
      status: 'ambiguous',
    };
  }

  return {
    query,
    reason:
      repos.length === 0
        ? 'No repositories were discovered under the configured repo root.'
        : 'No repository reference was detected in the message.',
    status: 'missing',
  };
}

function rememberCandidate(
  candidates: Map<string, { score: number; workspace: ResolvedWorkspace }>,
  workspace: ResolvedWorkspace,
  score: number,
): void {
  const existing = candidates.get(workspace.workspacePath);
  if (existing && existing.score >= score) {
    return;
  }

  candidates.set(workspace.workspacePath, { score, workspace });
}

function matchRepoReference(
  normalizedText: string,
  reference: string,
): { suffix?: string } | undefined {
  const normalizedReference = normalizeText(reference);
  if (!normalizedReference) {
    return undefined;
  }

  const boundaryPattern = `(^|[^a-z0-9_/-])${escapeRegExp(normalizedReference)}(?:/(?<suffix>[a-z0-9_/-]+))?(?=$|[^a-z0-9_/-])`;
  const match = normalizedText.match(new RegExp(boundaryPattern));
  if (!match) {
    return undefined;
  }

  const groups = match as RegExpMatchArray & { groups?: { suffix?: string } };
  return groups.groups?.suffix ? { suffix: groups.groups.suffix } : {};
}

function matchesWholeToken(normalizedText: string, reference: string): boolean {
  const normalizedReference = normalizeText(reference);
  if (!normalizedReference) {
    return false;
  }

  const boundaryPattern = `(^|[^a-z0-9_/-])${escapeRegExp(normalizedReference)}(?=$|[^a-z0-9_/-])`;
  return new RegExp(boundaryPattern).test(normalizedText);
}

function normalizeText(value: string): string {
  return value
    .replaceAll(/<@[^>]+>/g, ' ')
    .replaceAll(/["'`‘’“”]/g, ' ')
    .toLowerCase();
}

function normalizeRelativePath(value: string): string {
  const normalized = value
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
  return normalized === '.' ? '' : normalized;
}

function normalizeAlias(value: string): string {
  return normalizeText(value)
    .replaceAll(/\s+/g, '')
    .replaceAll(/[^\w/-]+/g, '');
}

function expandHomeDirectory(value: string): string {
  if (!value.startsWith('~/')) {
    return value;
  }

  return path.join(os.homedir(), value.slice(2));
}

function findExistingDirectory(targetPath: string): string | undefined {
  let currentPath = targetPath;

  while (true) {
    try {
      const stats = fs.statSync(currentPath);
      if (stats.isDirectory()) {
        return currentPath;
      }

      if (stats.isFile()) {
        return path.dirname(currentPath);
      }
    } catch {
      // Keep walking upward until we find an existing directory.
    }

    const parent = path.dirname(currentPath);
    if (parent === currentPath) {
      return undefined;
    }
    currentPath = parent;
  }
}

function isSubPath(targetPath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[$()*+.?[\\\]^{|}]/g, '\\$&');
}
