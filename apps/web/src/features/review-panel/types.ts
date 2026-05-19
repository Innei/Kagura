export interface ReviewChangedFile {
  additions?: number;
  deletions?: number;
  path: string;
  status: string;
}

export interface ReviewSession {
  baseBranch?: string | undefined;
  baseHead?: string | undefined;
  changedFiles: ReviewChangedFile[];
  executionId: string;
  head?: string | undefined;
  status: string;
  threadTs: string;
  workspaceLabel?: string | undefined;
  workspacePath: string;
  workspaceRepoId?: string | undefined;
}

export interface ReviewDiffResponse {
  diff: string;
  hasMore?: boolean | undefined;
  nextOffset?: number | undefined;
}

export interface ReviewTreeEntry {
  path: string;
  status?: string | undefined;
  type: 'file' | 'dir';
}

export interface ReviewTreeResponse {
  entries: ReviewTreeEntry[];
}

export interface ReviewFileResponse {
  content?: string | undefined;
  encoding: 'base64' | 'none' | 'text';
  mediaType: 'binary' | 'image' | 'text';
  mimeType?: string | undefined;
  path: string;
}
