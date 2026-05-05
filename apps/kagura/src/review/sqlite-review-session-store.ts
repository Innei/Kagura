import { eq } from 'drizzle-orm';

import type { AppDatabase } from '~/db/index.js';
import { reviewSessions } from '~/db/schema.js';

import type {
  ReviewSessionRecord,
  ReviewSessionStatus,
  ReviewSessionStore,
  StartReviewSessionInput,
} from './types.js';

export class SqliteReviewSessionStore implements ReviewSessionStore {
  constructor(private readonly db: AppDatabase) {}

  start(input: StartReviewSessionInput): void {
    this.db
      .insert(reviewSessions)
      .values({
        baseBranch: input.baseBranch ?? null,
        baseHead: input.baseHead ?? null,
        channelId: input.channelId,
        createdAt: input.createdAt,
        executionId: input.executionId,
        status: 'running',
        threadTs: input.threadTs,
        updatedAt: input.createdAt,
        workspaceLabel: input.workspaceLabel ?? null,
        workspacePath: input.workspacePath,
        workspaceRepoId: input.workspaceRepoId ?? null,
      })
      .onConflictDoUpdate({
        target: reviewSessions.executionId,
        set: {
          baseBranch: input.baseBranch ?? null,
          baseHead: input.baseHead ?? null,
          channelId: input.channelId,
          status: 'running',
          threadTs: input.threadTs,
          updatedAt: input.createdAt,
          workspaceLabel: input.workspaceLabel ?? null,
          workspacePath: input.workspacePath,
          workspaceRepoId: input.workspaceRepoId ?? null,
        },
      })
      .run();
  }

  complete(
    executionId: string,
    status: Exclude<ReviewSessionStatus, 'running'>,
    head?: string | undefined,
  ): void {
    this.db
      .update(reviewSessions)
      .set({
        head: head ?? null,
        status,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(reviewSessions.executionId, executionId))
      .run();
  }

  updateWorkspaceContext(
    executionId: string,
    input: {
      baseBranch?: string | undefined;
      workspaceLabel?: string | undefined;
      workspacePath: string;
      workspaceRepoId?: string | undefined;
    },
  ): void {
    this.db
      .update(reviewSessions)
      .set({
        baseBranch: input.baseBranch ?? null,
        updatedAt: new Date().toISOString(),
        workspaceLabel: input.workspaceLabel ?? null,
        workspacePath: input.workspacePath,
        workspaceRepoId: input.workspaceRepoId ?? null,
      })
      .where(eq(reviewSessions.executionId, executionId))
      .run();
  }

  get(executionId: string): ReviewSessionRecord | undefined {
    const row = this.db
      .select()
      .from(reviewSessions)
      .where(eq(reviewSessions.executionId, executionId))
      .get();

    return row ? rowToRecord(row) : undefined;
  }
}

function rowToRecord(row: typeof reviewSessions.$inferSelect): ReviewSessionRecord {
  return {
    channelId: row.channelId,
    createdAt: row.createdAt,
    executionId: row.executionId,
    status: row.status as ReviewSessionStatus,
    threadTs: row.threadTs,
    updatedAt: row.updatedAt,
    workspacePath: row.workspacePath,
    ...(row.baseBranch ? { baseBranch: row.baseBranch } : {}),
    ...(row.baseHead ? { baseHead: row.baseHead } : {}),
    ...(row.head ? { head: row.head } : {}),
    ...(row.workspaceLabel ? { workspaceLabel: row.workspaceLabel } : {}),
    ...(row.workspaceRepoId ? { workspaceRepoId: row.workspaceRepoId } : {}),
  };
}
