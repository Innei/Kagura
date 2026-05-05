import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

export interface WorkspaceContextDetectionOptions {
  originalWorkspaceLabel?: string | undefined;
  originalWorkspacePath?: string | undefined;
  workspaceRepoId?: string | undefined;
}

export interface DetectedWorkspaceContext {
  workspaceLabel: string;
  workspacePath: string;
  workspaceRepoId?: string | undefined;
}

export function detectWorkspaceContextFromText(
  text: string,
  options: WorkspaceContextDetectionOptions,
): DetectedWorkspaceContext | undefined {
  const originalTopLevel = options.originalWorkspacePath
    ? resolveGitTopLevel(options.originalWorkspacePath)
    : undefined;
  const candidates = extractAbsolutePaths(text);

  for (const candidate of candidates) {
    const context = buildWorkspaceContext(candidate, options, originalTopLevel);
    if (context) {
      return context;
    }
  }

  return undefined;
}

export function detectWorkspaceContextFromPath(
  candidatePath: string,
  options: WorkspaceContextDetectionOptions,
): DetectedWorkspaceContext | undefined {
  const originalTopLevel = options.originalWorkspacePath
    ? resolveGitTopLevel(options.originalWorkspacePath)
    : undefined;
  return buildWorkspaceContext(candidatePath, options, originalTopLevel);
}

function buildWorkspaceContext(
  candidatePath: string,
  options: WorkspaceContextDetectionOptions,
  originalTopLevel: string | undefined,
): DetectedWorkspaceContext | undefined {
  const topLevel = resolveGitTopLevel(candidatePath);
  if (!topLevel || topLevel === originalTopLevel) {
    return undefined;
  }
  if (!isSameGitRemote(topLevel, originalTopLevel)) {
    return undefined;
  }

  return {
    workspaceLabel: deriveWorkspaceLabel(topLevel, options.originalWorkspaceLabel),
    workspacePath: topLevel,
    ...(options.workspaceRepoId ? { workspaceRepoId: options.workspaceRepoId } : {}),
  };
}

function extractAbsolutePaths(text: string): string[] {
  const paths = new Set<string>();
  const matches = text.matchAll(/\/[^\s"'),;<>`|]+/g);
  for (const match of matches) {
    const value = match[0]?.replaceAll(/[,.:\]]+$/g, '');
    if (value) {
      paths.add(value);
    }
  }
  return [...paths];
}

function resolveGitTopLevel(candidatePath: string): string | undefined {
  try {
    const cwd = statSync(candidatePath).isDirectory() ? candidatePath : path.dirname(candidatePath);
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1_500,
    }).trim();
  } catch {
    return undefined;
  }
}

function isSameGitRemote(
  workspacePath: string,
  originalWorkspacePath: string | undefined,
): boolean {
  if (!originalWorkspacePath) {
    return true;
  }

  const remote = readGitRemote(workspacePath);
  const originalRemote = readGitRemote(originalWorkspacePath);
  return Boolean(remote && originalRemote && remote === originalRemote);
}

function readGitRemote(workspacePath: string): string | undefined {
  try {
    return execFileSync('git', ['-C', workspacePath, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1_500,
    }).trim();
  } catch {
    return undefined;
  }
}

function deriveWorkspaceLabel(workspacePath: string, originalLabel: string | undefined): string {
  const basename = path.basename(workspacePath);
  if (!basename) {
    return originalLabel ?? workspacePath;
  }
  if (!originalLabel || originalLabel === basename || originalLabel.endsWith(`/${basename}`)) {
    return basename;
  }
  return basename;
}
