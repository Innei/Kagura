import { count, eq } from 'drizzle-orm';

import type { AppDatabase } from '~/db/index.js';
import { sessions } from '~/db/schema.js';
import type { AppLogger } from '~/logger/index.js';

import type { SessionRecord, SessionStore } from './types.js';

export class SqliteSessionStore implements SessionStore {
  constructor(
    private readonly db: AppDatabase,
    private readonly logger: AppLogger,
  ) {}

  countAll(): number {
    const row = this.db.select({ value: count() }).from(sessions).get();
    return row?.value ?? 0;
  }

  get(threadTs: string): SessionRecord | undefined {
    const row = this.db.select().from(sessions).where(eq(sessions.threadTs, threadTs)).get();
    if (!row) return undefined;
    return this.rowToRecord(row);
  }

  listAll(): SessionRecord[] {
    return this.db
      .select()
      .from(sessions)
      .all()
      .map((row) => this.rowToRecord(row));
  }

  upsert(record: SessionRecord): SessionRecord {
    this.db
      .insert(sessions)
      .values({
        threadTs: record.threadTs,
        channelId: record.channelId,
        rootMessageTs: record.rootMessageTs,
        bootstrapMessageTs: record.bootstrapMessageTs ?? null,
        streamMessageTs: record.streamMessageTs ?? null,
        providerSessionId: record.providerSessionId ?? null,
        agentProvider: record.agentProvider ?? null,
        agentModel: record.agentModel ?? null,
        conversationMode: record.conversationMode ?? null,
        a2aLead: record.a2aLead ?? null,
        a2aTeamId: record.a2aTeamId ?? null,
        a2aParticipantsJson: record.a2aParticipantsJson ?? null,
        a2aPendingAssignments: record.a2aPendingAssignments ?? null,
        a2aSummaryState: record.a2aSummaryState ?? null,
        workspaceRepoId: record.workspaceRepoId ?? null,
        workspaceRepoPath: record.workspaceRepoPath ?? null,
        workspacePath: record.workspacePath ?? null,
        workspaceLabel: record.workspaceLabel ?? null,
        workspaceSource: record.workspaceSource ?? null,
        lastTurnTriggerTs: record.lastTurnTriggerTs ?? null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      })
      .onConflictDoUpdate({
        target: sessions.threadTs,
        set: {
          channelId: record.channelId,
          rootMessageTs: record.rootMessageTs,
          bootstrapMessageTs: record.bootstrapMessageTs ?? null,
          streamMessageTs: record.streamMessageTs ?? null,
          providerSessionId: record.providerSessionId ?? null,
          agentProvider: record.agentProvider ?? null,
          agentModel: record.agentModel ?? null,
          conversationMode: record.conversationMode ?? null,
          a2aLead: record.a2aLead ?? null,
          a2aTeamId: record.a2aTeamId ?? null,
          a2aParticipantsJson: record.a2aParticipantsJson ?? null,
          a2aPendingAssignments: record.a2aPendingAssignments ?? null,
          a2aSummaryState: record.a2aSummaryState ?? null,
          workspaceRepoId: record.workspaceRepoId ?? null,
          workspaceRepoPath: record.workspaceRepoPath ?? null,
          workspacePath: record.workspacePath ?? null,
          workspaceLabel: record.workspaceLabel ?? null,
          workspaceSource: record.workspaceSource ?? null,
          lastTurnTriggerTs: record.lastTurnTriggerTs ?? null,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        },
      })
      .run();

    this.logger.debug('Upserted session record for thread %s', record.threadTs);
    return { ...record };
  }

  patch(threadTs: string, patch: Partial<SessionRecord>): SessionRecord | undefined {
    const { threadTs: _discarded, ...safePatch } = patch;

    const existing = this.get(threadTs);
    if (!existing) return undefined;

    const next: SessionRecord = {
      ...existing,
      ...safePatch,
      threadTs,
      updatedAt: new Date().toISOString(),
    };

    this.db
      .update(sessions)
      .set({
        channelId: next.channelId,
        rootMessageTs: next.rootMessageTs,
        bootstrapMessageTs: next.bootstrapMessageTs ?? null,
        streamMessageTs: next.streamMessageTs ?? null,
        providerSessionId: next.providerSessionId ?? null,
        agentProvider: next.agentProvider ?? null,
        agentModel: next.agentModel ?? null,
        conversationMode: next.conversationMode ?? null,
        a2aLead: next.a2aLead ?? null,
        a2aTeamId: next.a2aTeamId ?? null,
        a2aParticipantsJson: next.a2aParticipantsJson ?? null,
        a2aPendingAssignments: next.a2aPendingAssignments ?? null,
        a2aSummaryState: next.a2aSummaryState ?? null,
        workspaceRepoId: next.workspaceRepoId ?? null,
        workspaceRepoPath: next.workspaceRepoPath ?? null,
        workspacePath: next.workspacePath ?? null,
        workspaceLabel: next.workspaceLabel ?? null,
        workspaceSource: next.workspaceSource ?? null,
        lastTurnTriggerTs: next.lastTurnTriggerTs ?? null,
        createdAt: next.createdAt,
        updatedAt: next.updatedAt,
      })
      .where(eq(sessions.threadTs, threadTs))
      .run();

    this.logger.debug('Patched session record for thread %s', threadTs);
    return { ...next };
  }

  private rowToRecord(row: typeof sessions.$inferSelect): SessionRecord {
    const record: SessionRecord = {
      channelId: row.channelId,
      createdAt: row.createdAt,
      rootMessageTs: row.rootMessageTs,
      threadTs: row.threadTs,
      updatedAt: row.updatedAt,
    };
    if (row.bootstrapMessageTs !== null) record.bootstrapMessageTs = row.bootstrapMessageTs;
    if (row.providerSessionId !== null) record.providerSessionId = row.providerSessionId;
    if (row.conversationMode !== null) record.conversationMode = row.conversationMode;
    if (row.a2aLead !== null) record.a2aLead = row.a2aLead;
    if (row.a2aTeamId !== null) record.a2aTeamId = row.a2aTeamId;
    if (row.a2aParticipantsJson !== null) record.a2aParticipantsJson = row.a2aParticipantsJson;
    if (row.a2aPendingAssignments !== null) {
      record.a2aPendingAssignments = row.a2aPendingAssignments;
    }
    if (row.a2aSummaryState !== null) record.a2aSummaryState = row.a2aSummaryState;
    if (row.streamMessageTs !== null) record.streamMessageTs = row.streamMessageTs;
    if (row.workspaceRepoId !== null) record.workspaceRepoId = row.workspaceRepoId;
    if (row.workspaceRepoPath !== null) record.workspaceRepoPath = row.workspaceRepoPath;
    if (row.workspacePath !== null) record.workspacePath = row.workspacePath;
    if (row.workspaceLabel !== null) record.workspaceLabel = row.workspaceLabel;
    if (row.workspaceSource !== null) record.workspaceSource = row.workspaceSource;
    if (row.agentProvider !== null) record.agentProvider = row.agentProvider;
    if (row.agentModel !== null) record.agentModel = row.agentModel;
    if (row.lastTurnTriggerTs !== null) record.lastTurnTriggerTs = row.lastTurnTriggerTs;
    return record;
  }
}
