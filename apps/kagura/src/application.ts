import fs from 'node:fs';
import path from 'node:path';

import { ClaudeAgentSdkExecutor } from '~/agent/providers/claude-code/adapter.js';
import { CodexCliExecutor } from '~/agent/providers/codex-cli/adapter.js';
import { PiAgentExecutor } from '~/agent/providers/pi-agent/adapter.js';
import { createProviderRegistry } from '~/agent/registry.js';
import type { AgentExecutor } from '~/agent/types.js';
import { SqliteAnalyticsStore } from '~/analytics/sqlite-analytics-store.js';
import { SqliteChannelPreferenceStore } from '~/channel-preference/sqlite-channel-preference-store.js';
import { createDatabase } from '~/db/index.js';
import { FileClaudeExecutionProbe } from '~/e2e/live/file-claude-execution-probe.js';
import { FileSlackStatusProbe } from '~/e2e/live/file-slack-status-probe.js';
import {
  appConfigAgentTeams,
  env,
  resolveConfiguredSessionDbPath,
  validateLiveE2EEnv,
} from '~/env/server.js';
import { type AppLogger, createRootLogger } from '~/logger/index.js';
import { SqliteMemoryIngestionAuditStore } from '~/memory/ingestion/audit-store.js';
import { MemoryIngestionService } from '~/memory/ingestion/service.js';
import { SqliteMemoryStore } from '~/memory/memory-store.js';
import { SqliteReconcileAuditStore } from '~/memory/reconciler/audit-store.js';
import { MemoryReconciler } from '~/memory/reconciler/index.js';
import { OpenAICompatibleClient } from '~/memory/reconciler/llm-client.js';
import { SqliteReconcileStateStore } from '~/memory/reconciler/state-store.js';
import { GitReviewService } from '~/review/git-review-service.js';
import { SqliteReviewSessionStore } from '~/review/sqlite-review-session-store.js';
import { SqliteSessionStore } from '~/session/sqlite-session-store.js';
import { createSlackApp, type KaguraSlackApp, type SlackAppCredentials } from '~/slack/app.js';
import { syncSlashCommands } from '~/slack/commands/manifest-sync.js';
import { SqlitePersistentExecutionStore } from '~/slack/execution/persistent-execution-store.js';
import {
  createThreadExecutionRegistry,
  type ThreadExecutionRegistry,
} from '~/slack/execution/thread-execution-registry.js';
import { SqliteA2ACoordinatorStore } from '~/slack/ingress/a2a-coordinator-store.js';
import { FileQuietAssistantMessageRecorder } from '~/slack/ingress/a2a-output-diagnostics.js';
import type { AgentTeamsConfig } from '~/slack/ingress/agent-team-routing.js';
import type { ConversationDispatchInput } from '~/slack/ingress/conversation-dispatch.js';
import { SlackPermissionBridge } from '~/slack/interaction/permission-bridge.js';
import { SlackUserInputBridge } from '~/slack/interaction/user-input-bridge.js';
import { startSlackAppWithRetry } from '~/slack/network-guard.js';
import { createReviewPanelServer, type ReviewPanelServer } from '~/web/review-panel.js';
import { WorkspaceResolver } from '~/workspace/resolver.js';

export interface RuntimeApplication {
  dispatchThreadConversation: (input: ConversationDispatchInput) => Promise<void>;
  readonly logger: AppLogger;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  readonly threadExecutionRegistry: ThreadExecutionRegistry;
}

export interface RuntimeApplicationOptions {
  a2aCoordinatorDbPath?: string | undefined;
  a2aDiagnosticsDir?: string | undefined;
  a2aOutputMode?: typeof env.A2A_OUTPUT_MODE | undefined;
  agentTeams?: AgentTeamsConfig | undefined;
  claudePermissionMode?: typeof env.CLAUDE_PERMISSION_MODE | undefined;
  defaultProviderId?: 'claude-code' | 'codex-cli' | 'pi-agent' | undefined;
  executionProbePath?: string | undefined;
  instanceLabel?: string | undefined;
  memoryIngestionLlm?: Pick<OpenAICompatibleClient, 'chat'> | undefined;
  sessionDbPath?: string | undefined;
  skipManifestSync?: boolean | undefined;
  slackCredentials?: SlackAppCredentials | undefined;
  statusProbePath?: string | undefined;
}

export function createApplication(options?: RuntimeApplicationOptions): RuntimeApplication {
  const logger = createRootLogger().withTag(options?.instanceLabel ?? 'bootstrap');
  validateLiveE2EEnv();

  const dbPath =
    options?.sessionDbPath !== undefined
      ? path.resolve(process.cwd(), options.sessionDbPath)
      : resolveConfiguredSessionDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const { db, sqlite } = createDatabase(dbPath);
  const a2aCoordinatorDbPath = path.resolve(
    process.cwd(),
    options?.a2aCoordinatorDbPath ?? env.A2A_COORDINATOR_DB_PATH,
  );
  fs.mkdirSync(path.dirname(a2aCoordinatorDbPath), { recursive: true });
  const a2aCoordinatorStore = new SqliteA2ACoordinatorStore(a2aCoordinatorDbPath);
  const sessionStore = new SqliteSessionStore(db, logger.withTag('session'));
  const reconcileStateStore = new SqliteReconcileStateStore(db);
  const reconcileAuditStore = new SqliteReconcileAuditStore(db);
  const memoryIngestionAuditStore = new SqliteMemoryIngestionAuditStore(db);
  const memoryStore = new SqliteMemoryStore(db, logger.withTag('memory'), reconcileStateStore);
  const channelPreferenceStore = new SqliteChannelPreferenceStore(
    db,
    logger.withTag('channel-preference'),
  );
  const analyticsStore = new SqliteAnalyticsStore(db, logger.withTag('analytics'));
  const persistentExecutionStore = new SqlitePersistentExecutionStore(sqlite);
  const reviewSessionStore = new SqliteReviewSessionStore(db);
  const reviewService = new GitReviewService(reviewSessionStore);

  const reconcilerApiKey = env.KAGURA_MEMORY_RECONCILER_API_KEY?.trim();
  const reconcilerLlmEnabled = env.KAGURA_MEMORY_RECONCILER_ENABLED && Boolean(reconcilerApiKey);

  if (env.KAGURA_MEMORY_RECONCILER_ENABLED && !reconcilerApiKey) {
    logger.warn(
      'KAGURA_MEMORY_RECONCILER_ENABLED=true but KAGURA_MEMORY_RECONCILER_API_KEY is missing or empty; LLM consolidation disabled, prune-only mode active. Set KAGURA_MEMORY_RECONCILER_API_KEY in env to enable LLM consolidation.',
    );
  }

  if (!env.KAGURA_MEMORY_RECONCILER_ENABLED) {
    logger.info('Memory reconciler disabled by config; expired-only prune via startup hook');
  }

  const memoryReconcilerLlm =
    env.KAGURA_MEMORY_RECONCILER_ENABLED && reconcilerApiKey
      ? new OpenAICompatibleClient({
          baseUrl: env.KAGURA_MEMORY_RECONCILER_BASE_URL,
          apiKey: reconcilerApiKey,
          model: env.KAGURA_MEMORY_RECONCILER_MODEL,
          timeoutMs: env.KAGURA_MEMORY_RECONCILER_TIMEOUT_MS,
          maxTokens: env.KAGURA_MEMORY_RECONCILER_MAX_TOKENS,
        })
      : undefined;

  const memoryIngestionLlm = options?.memoryIngestionLlm ?? memoryReconcilerLlm;
  const memoryIngestionService = memoryIngestionLlm
    ? new MemoryIngestionService({
        auditStore: memoryIngestionAuditStore,
        llm: memoryIngestionLlm,
        logger: logger.withTag('memory-ingestion'),
        memoryStore,
      })
    : undefined;

  const memoryReconciler = new MemoryReconciler({
    db,
    memoryStore,
    reconcileStore: reconcileStateStore,
    auditStore: reconcileAuditStore,
    logger: logger.withTag('memory-reconciler'),
    intervalMs: env.KAGURA_MEMORY_RECONCILER_INTERVAL_MS,
    writeThreshold: env.KAGURA_MEMORY_RECONCILER_WRITE_THRESHOLD,
    llmEnabled: reconcilerLlmEnabled,
    ...(memoryReconcilerLlm ? { llm: memoryReconcilerLlm } : {}),
    batchSize: env.KAGURA_MEMORY_RECONCILER_BATCH_SIZE,
  });

  const workspaceResolver = new WorkspaceResolver({
    repoRootDir: env.REPO_ROOT_DIR,
    scanDepth: env.REPO_SCAN_DEPTH,
  });
  const statusProbe = env.SLACK_E2E_ENABLED
    ? new FileSlackStatusProbe(options?.statusProbePath ?? env.SLACK_E2E_STATUS_PROBE_PATH)
    : undefined;
  const executionProbe = env.SLACK_E2E_ENABLED
    ? new FileClaudeExecutionProbe(
        options?.executionProbePath ?? env.SLACK_E2E_EXECUTION_PROBE_PATH,
      )
    : undefined;
  const permissionBridge = new SlackPermissionBridge(logger.withTag('slack:permission'));
  const userInputBridge = new SlackUserInputBridge(logger.withTag('slack:user-input'));
  const a2aQuietMessageRecorder = new FileQuietAssistantMessageRecorder(
    options?.a2aDiagnosticsDir ?? env.A2A_DIAGNOSTICS_DIR,
    logger.withTag('a2a:diagnostics'),
  );

  const ccExecutor = new ClaudeAgentSdkExecutor(
    logger.withTag('claude:session'),
    memoryStore,
    channelPreferenceStore,
    executionProbe,
    options?.claudePermissionMode ? { permissionMode: options.claudePermissionMode } : undefined,
  );
  const codexExecutor = new CodexCliExecutor(
    logger.withTag('codex:session'),
    memoryStore,
    channelPreferenceStore,
    dbPath,
  );
  const piAgentExecutor = new PiAgentExecutor(
    logger.withTag('pi-agent:session'),
    channelPreferenceStore,
    dbPath,
  );
  const providerRegistry = createProviderRegistry(
    options?.defaultProviderId ?? env.AGENT_DEFAULT_PROVIDER,
    new Map<string, AgentExecutor>([
      ['claude-code', ccExecutor],
      ['codex-cli', codexExecutor],
      ['pi-agent', piAgentExecutor],
    ]),
  );

  const threadExecutionRegistry = createThreadExecutionRegistry({
    logger: logger.withTag('slack:execution'),
  });

  const slackApp: KaguraSlackApp = createSlackApp(
    {
      a2aCoordinatorStore,
      a2aOutputMode: options?.a2aOutputMode ?? env.A2A_OUTPUT_MODE,
      a2aQuietMessageRecorder,
      analyticsStore,
      agentTeams: options?.agentTeams ?? appConfigAgentTeams,
      channelPreferenceStore,
      logger,
      ...(memoryIngestionService ? { memoryIngestionService } : {}),
      memoryStore,
      permissionBridge,
      persistentExecutionStore,
      reviewPanelBaseUrl: env.KAGURA_REVIEW_PANEL_ENABLED
        ? env.KAGURA_REVIEW_PANEL_BASE_URL
        : undefined,
      reviewSessionStore,
      sessionStore,
      providerRegistry,
      threadExecutionRegistry,
      userInputBridge,
      workspaceResolver,
      ...(statusProbe ? { statusProbe } : {}),
    },
    options?.slackCredentials ? { credentials: options.slackCredentials } : undefined,
  );
  const reviewPanelServer: ReviewPanelServer | undefined = env.KAGURA_REVIEW_PANEL_ENABLED
    ? createReviewPanelServer({
        assetsDir: path.resolve(process.cwd(), env.KAGURA_REVIEW_PANEL_ASSETS_DIR),
        baseUrl: env.KAGURA_REVIEW_PANEL_BASE_URL,
        host: env.KAGURA_REVIEW_PANEL_HOST,
        logger: logger.withTag('review:web'),
        port: env.KAGURA_REVIEW_PANEL_PORT,
        reviewService,
      })
    : undefined;
  let slackAppStarted = false;
  let reviewPanelStarted = false;

  return {
    dispatchThreadConversation: (input) => slackApp.dispatchThreadConversation(input),
    logger,
    threadExecutionRegistry,
    async start() {
      if (
        !options?.skipManifestSync &&
        env.SLACK_APP_ID &&
        (env.SLACK_CONFIG_TOKEN || env.SLACK_CONFIG_REFRESH_TOKEN)
      ) {
        await syncSlashCommands({
          appId: env.SLACK_APP_ID,
          configToken: env.SLACK_CONFIG_TOKEN,
          refreshToken: env.SLACK_CONFIG_REFRESH_TOKEN,
          tokenStorePath: env.SLACK_CONFIG_TOKEN_STORE_PATH,
          logger: logger.withTag('manifest'),
        }).catch((error) => {
          logger.warn(
            'Slash command manifest sync failed (non-fatal): %s',
            error instanceof Error ? error.message : String(error),
          );
        });
      }
      await startSlackAppWithRetry(async () => {
        await slackApp.start();
        slackAppStarted = true;
      }, logger.withTag('slack:socket'));
      if (reviewPanelServer) {
        await reviewPanelServer.start();
        reviewPanelStarted = true;
      }
      memoryReconciler.start();
      slackApp.startA2ASummaryPoller?.();
      logger.info('Slack Socket Mode application started.');
      void slackApp.recoverPendingExecutions?.().catch((error) => {
        logger.error(
          'Failed to recover interrupted agent executions: %s',
          error instanceof Error ? error.message : String(error),
        );
      });
    },
    async stop() {
      slackApp.stopA2ASummaryPoller?.();
      if (reviewPanelStarted) {
        await reviewPanelServer?.stop();
        reviewPanelStarted = false;
      }
      if (slackAppStarted) {
        await slackApp.stop();
        slackAppStarted = false;
      }
      memoryReconciler.stop();
      await providerRegistry.drain();
      a2aCoordinatorStore.close?.();
      sqlite.close();
      logger.info('Slack Socket Mode application stopped.');
    },
  };
}
