import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const sessions = sqliteTable('sessions', {
  threadTs: text('thread_ts').primaryKey(),
  channelId: text('channel_id').notNull(),
  rootMessageTs: text('root_message_ts').notNull(),
  bootstrapMessageTs: text('bootstrap_message_ts'),
  streamMessageTs: text('stream_message_ts'),
  // Physical column name is kept for backward compatibility with existing SQLite files.
  providerSessionId: text('claude_session_id'),
  agentProvider: text('agent_provider'),
  agentModel: text('agent_model'),
  conversationMode: text('conversation_mode', { enum: ['general', 'a2a'] }),
  a2aLead: text('a2a_lead'),
  a2aTeamId: text('a2a_team_id'),
  a2aParticipantsJson: text('a2a_participants_json'),
  a2aPendingAssignments: text('a2a_pending_assignments'),
  a2aSummaryState: text('a2a_summary_state'),
  workspaceRepoId: text('workspace_repo_id'),
  workspaceRepoPath: text('workspace_repo_path'),
  workspacePath: text('workspace_path'),
  workspaceLabel: text('workspace_label'),
  workspaceSource: text('workspace_source', { enum: ['auto', 'manual'] }),
  lastTurnTriggerTs: text('last_turn_trigger_ts'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const memories = sqliteTable('memories', {
  id: text('id').primaryKey(),
  repoId: text('repo_id'),
  threadTs: text('thread_ts'),
  category: text('category', {
    enum: ['task_completed', 'decision', 'context', 'observation', 'preference'],
  }).notNull(),
  content: text('content').notNull(),
  metadata: text('metadata'),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at'),
});

export const sessionAnalytics = sqliteTable('session_analytics', {
  id: text('id').primaryKey(),
  threadTs: text('thread_ts').notNull(),
  userId: text('user_id'),
  totalCostUSD: real('total_cost_usd'),
  durationMs: integer('duration_ms'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  cacheReadInputTokens: integer('cache_read_input_tokens'),
  cacheCreationInputTokens: integer('cache_creation_input_tokens'),
  modelUsageJson: text('model_usage_json'),
  createdAt: text('created_at').notNull(),
});

export const channelPreferences = sqliteTable('channel_preferences', {
  channelId: text('channel_id').primaryKey(),
  defaultWorkspaceInput: text('default_workspace_input'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const agentExecutions = sqliteTable('agent_executions', {
  executionId: text('execution_id').primaryKey(),
  threadTs: text('thread_ts').notNull(),
  channelId: text('channel_id').notNull(),
  messageTs: text('message_ts').notNull(),
  rootMessageTs: text('root_message_ts').notNull(),
  userId: text('user_id').notNull(),
  providerId: text('provider_id').notNull(),
  status: text('status').notNull(),
  text: text('text').notNull(),
  teamId: text('team_id'),
  resumeHandle: text('resume_handle'),
  terminalPhase: text('terminal_phase'),
  attemptCount: integer('attempt_count').notNull().default(0),
  startedAt: text('started_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const reviewSessions = sqliteTable('review_sessions', {
  executionId: text('execution_id').primaryKey(),
  threadTs: text('thread_ts').notNull(),
  channelId: text('channel_id').notNull(),
  workspacePath: text('workspace_path').notNull(),
  workspaceRepoId: text('workspace_repo_id'),
  workspaceLabel: text('workspace_label'),
  baseHead: text('base_head'),
  baseBranch: text('base_branch'),
  head: text('head'),
  diffSnapshot: text('diff_snapshot'),
  changedFilesSnapshot: text('changed_files_snapshot'),
  status: text('status').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const memoryReconcileState = sqliteTable('memory_reconcile_state', {
  bucketKey: text('bucket_key').primaryKey(),
  lastReconciledAt: text('last_reconciled_at'),
  lastSeenMaxCreatedAt: text('last_seen_max_created_at'),
  lastCount: integer('last_count').notNull().default(0),
  writesSinceReconcile: integer('writes_since_reconcile').notNull().default(0),
});

export const memoryReconcileRuns = sqliteTable('memory_reconcile_runs', {
  id: text('id').primaryKey(),
  bucketKey: text('bucket_key').notNull(),
  status: text('status', { enum: ['running', 'completed', 'failed'] }).notNull(),
  recordCount: integer('record_count').notNull(),
  rawResponse: text('raw_response'),
  error: text('error'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
});

export const memoryReconcileOps = sqliteTable('memory_reconcile_ops', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  bucketKey: text('bucket_key').notNull(),
  kind: text('kind').notNull(),
  sourceIds: text('source_ids').notNull(),
  targetId: text('target_id'),
  payload: text('payload'),
  createdAt: text('created_at').notNull(),
});

export const memoryIngestionRuns = sqliteTable('memory_ingestion_runs', {
  id: text('id').primaryKey(),
  executionId: text('execution_id').notNull(),
  finalTextHash: text('final_text_hash').notNull(),
  status: text('status', { enum: ['running', 'completed', 'failed', 'skipped'] }).notNull(),
  providerId: text('provider_id'),
  channelId: text('channel_id').notNull(),
  threadTs: text('thread_ts').notNull(),
  messageTs: text('message_ts').notNull(),
  repoId: text('repo_id'),
  workspaceLabel: text('workspace_label'),
  input: text('input').notNull(),
  rawResponse: text('raw_response'),
  error: text('error'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
});

export const memoryIngestionCandidates = sqliteTable('memory_ingestion_candidates', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  action: text('action', { enum: ['save', 'skip'] }).notNull(),
  status: text('status', { enum: ['applied', 'skipped', 'invalid'] }).notNull(),
  category: text('category', {
    enum: ['task_completed', 'decision', 'context', 'observation', 'preference'],
  }),
  scope: text('scope', { enum: ['global', 'workspace'] }),
  content: text('content'),
  confidence: real('confidence'),
  reason: text('reason'),
  memoryId: text('memory_id'),
  payload: text('payload'),
  createdAt: text('created_at').notNull(),
});
