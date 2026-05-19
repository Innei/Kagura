export type ReviewSessionStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface ReviewSessionRecord {
  baseBranch?: string | undefined;
  baseHead?: string | undefined;
  changedFilesSnapshot?: string | undefined;
  channelId: string;
  createdAt: string;
  diffSnapshot?: string | undefined;
  executionId: string;
  head?: string | undefined;
  status: ReviewSessionStatus;
  threadTs: string;
  updatedAt: string;
  workspaceLabel?: string | undefined;
  workspacePath: string;
  workspaceRepoId?: string | undefined;
}

export interface StartReviewSessionInput {
  baseBranch?: string | undefined;
  baseHead?: string | undefined;
  channelId: string;
  createdAt: string;
  executionId: string;
  threadTs: string;
  workspaceLabel?: string | undefined;
  workspacePath: string;
  workspaceRepoId?: string | undefined;
}

export interface ReviewSessionStore {
  complete: (
    executionId: string,
    status: Exclude<ReviewSessionStatus, 'running'>,
    result?:
      | string
      | {
          changedFilesSnapshot?: string | undefined;
          diffSnapshot?: string | undefined;
          head?: string | undefined;
        }
      | undefined,
  ) => void;
  get: (executionId: string) => ReviewSessionRecord | undefined;
  start: (input: StartReviewSessionInput) => void;
  updateWorkspaceContext?: (
    executionId: string,
    input: {
      baseBranch?: string | undefined;
      baseHead?: string | undefined;
      workspaceLabel?: string | undefined;
      workspacePath: string;
      workspaceRepoId?: string | undefined;
    },
  ) => void;
}
