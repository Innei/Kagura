import { App } from '@slack/bolt';

import type { AgentProviderRegistry } from '~/agent/registry.js';
import type { SessionAnalyticsStore } from '~/analytics/types.js';
import type { ChannelPreferenceStore } from '~/channel-preference/types.js';
import { env } from '~/env/server.js';
import type { AppLogger } from '~/logger/index.js';
import { redactUnknown } from '~/logger/redact.js';
import type { MemoryIngestionService } from '~/memory/ingestion/service.js';
import type { MemoryStore } from '~/memory/types.js';
import type { ReviewSessionStore } from '~/review/types.js';
import type { SessionStore } from '~/session/types.js';
import type { WorkspaceResolver } from '~/workspace/resolver.js';
import type { ThreadWorkspaceManager } from '~/workspace/thread-worktree.js';

import { registerSlashCommands } from './commands/register.js';
import { SlackThreadContextLoader } from './context/thread-context-loader.js';
import { recoverPendingExecutions } from './execution/execution-recovery.js';
import type { PersistentExecutionStore } from './execution/persistent-execution-store.js';
import type { ThreadExecutionRegistry } from './execution/thread-execution-registry.js';
import type { A2ACoordinatorStore } from './ingress/a2a-coordinator-store.js';
import type {
  A2AOutputMode,
  QuietAssistantMessageRecorder,
} from './ingress/a2a-output-diagnostics.js';
import { createAgentSessionStoppedHandler } from './ingress/agent-session-stopped-handler.js';
import type { AgentTeamsConfig } from './ingress/agent-team-routing.js';
import {
  type ConversationDispatchInput,
  dispatchThreadConversation,
} from './ingress/conversation-dispatch.js';
import { createHomeTabHandler, HOME_TAB_REFRESH_ACTION_ID } from './ingress/home-tab-handler.js';
import { createReactionStopHandler } from './ingress/reaction-stop-handler.js';
import { startA2ASummaryPoller } from './ingress/scenarios/a2a/summary-runner.js';
import { createThreadReplyHandler } from './ingress/thread-reply-handler.js';
import { WORKSPACE_PICKER_ACTION_ID } from './ingress/workspace-resolution.js';
import type { SlackPermissionBridge } from './interaction/permission-bridge.js';
import {
  createPermissionActionHandler,
  PERMISSION_APPROVE_ACTION_ID,
  PERMISSION_DENY_ACTION_ID,
} from './interaction/permission-bridge.js';
import type { SlackUserInputBridge } from './interaction/user-input-bridge.js';
import {
  createStopMessageActionHandler,
  STOP_MESSAGE_ACTION_CALLBACK_ID,
} from './interactions/stop-message-action.js';
import {
  createWorkspaceMessageActionHandler,
  createWorkspaceSelectionViewHandler,
  WORKSPACE_MESSAGE_ACTION_CALLBACK_ID,
  WORKSPACE_MODAL_CALLBACK_ID,
} from './interactions/workspace-message-action.js';
import { createWorkspacePickerActionHandler } from './interactions/workspace-picker-action.js';
import { createSlackNetworkAgent, createSlackWebClientOptions } from './network-guard.js';
import { SlackRenderer } from './render/slack-renderer.js';
import type { SlackStatusProbe } from './render/status-probe.js';
import type { SlackWebClientLike } from './types.js';

export interface SlackApplicationDependencies {
  a2aCoordinatorStore?: A2ACoordinatorStore | undefined;
  a2aOutputMode?: A2AOutputMode | undefined;
  a2aQuietMessageRecorder?: QuietAssistantMessageRecorder | undefined;
  agentTeams?: AgentTeamsConfig | undefined;
  analyticsStore: SessionAnalyticsStore;
  channelPreferenceStore: ChannelPreferenceStore;
  logger: AppLogger;
  memoryIngestionService?: MemoryIngestionService | undefined;
  memoryStore: MemoryStore;
  permissionBridge: SlackPermissionBridge;
  persistentExecutionStore?: PersistentExecutionStore | undefined;
  providerRegistry: AgentProviderRegistry;
  reviewPanelBaseUrl?: string | undefined;
  reviewSessionStore?: ReviewSessionStore | undefined;
  sessionStore: SessionStore;
  statusProbe?: SlackStatusProbe;
  threadExecutionRegistry: ThreadExecutionRegistry;
  threadWorkspaceManager?: ThreadWorkspaceManager | undefined;
  userInputBridge: SlackUserInputBridge;
  workspaceResolver: WorkspaceResolver;
}

export interface SlackAppCredentials {
  appToken: string;
  botToken: string;
  signingSecret: string;
}

export type KaguraSlackApp = App & {
  dispatchThreadConversation: (input: ConversationDispatchInput) => Promise<void>;
  recoverPendingExecutions?: () => Promise<void>;
  startA2ASummaryPoller?: () => void;
  stopA2ASummaryPoller?: () => void;
};

export function createSlackApp(
  deps: SlackApplicationDependencies,
  options?: {
    credentials?: SlackAppCredentials | undefined;
  },
): KaguraSlackApp {
  const networkAgent = createSlackNetworkAgent();
  const credentials = options?.credentials ?? {
    appToken: env.SLACK_APP_TOKEN,
    botToken: env.SLACK_BOT_TOKEN,
    signingSecret: env.SLACK_SIGNING_SECRET,
  };
  const app = new App({
    token: credentials.botToken,
    appToken: credentials.appToken,
    signingSecret: credentials.signingSecret,
    socketMode: true,
    agent: networkAgent,
    clientOptions: createSlackWebClientOptions(networkAgent),
  });

  const renderer = new SlackRenderer(deps.logger.withTag('slack:render'), deps.statusProbe);
  const threadContextLoader = new SlackThreadContextLoader(deps.logger.withTag('slack:context'));
  const defaultExecutor = deps.providerRegistry.getExecutor(
    deps.providerRegistry.defaultProviderId,
  );
  const ingressDeps = {
    a2aCoordinatorStore: deps.a2aCoordinatorStore,
    a2aOutputMode: deps.a2aOutputMode,
    a2aQuietMessageRecorder: deps.a2aQuietMessageRecorder,
    analyticsStore: deps.analyticsStore,
    agentTeams: deps.agentTeams,
    channelPreferenceStore: deps.channelPreferenceStore,
    logger: deps.logger.withTag('slack:ingress'),
    memoryIngestionService: deps.memoryIngestionService,
    memoryStore: deps.memoryStore,
    renderer,
    threadContextLoader,
    sessionStore: deps.sessionStore,
    claudeExecutor: defaultExecutor,
    providerRegistry: deps.providerRegistry,
    permissionBridge: deps.permissionBridge,
    persistentExecutionStore: deps.persistentExecutionStore,
    reviewPanelBaseUrl: deps.reviewPanelBaseUrl,
    reviewSessionStore: deps.reviewSessionStore,
    threadExecutionRegistry: deps.threadExecutionRegistry,
    threadWorkspaceManager: deps.threadWorkspaceManager,
    userInputBridge: deps.userInputBridge,
    workspaceResolver: deps.workspaceResolver,
  };
  let stopA2ASummaryPoller: (() => void) | undefined;

  const homeTabHandler = createHomeTabHandler({
    analyticsStore: deps.analyticsStore,
    logger: deps.logger.withTag('slack:home'),
    memoryStore: deps.memoryStore,
    providerRegistry: deps.providerRegistry,
    sessionStore: deps.sessionStore,
    workspaceResolver: deps.workspaceResolver,
  });

  app.event('app_home_opened', homeTabHandler);
  app.action(HOME_TAB_REFRESH_ACTION_ID, async ({ ack, body, client }) => {
    await ack();
    await homeTabHandler({ client, event: { user: body.user.id, tab: 'home' } });
  });
  app.event('message', createThreadReplyHandler(ingressDeps));
  // Bolt 4.7.1 predates agent_session_stopped, so its event-name union rejects it.
  (app.event as (name: string, handler: unknown) => void)(
    'agent_session_stopped',
    createAgentSessionStoppedHandler({
      logger: deps.logger.withTag('slack:agent-session-stop'),
      threadExecutionRegistry: deps.threadExecutionRegistry,
    }),
  );
  app.event(
    'reaction_added',
    createReactionStopHandler({
      logger: deps.logger.withTag('slack:reaction-stop'),
      threadExecutionRegistry: deps.threadExecutionRegistry,
    }),
  );
  registerSlashCommands(app, {
    logger: deps.logger.withTag('slack:commands'),
    memoryStore: deps.memoryStore,
    providerRegistry: deps.providerRegistry,
    sessionStore: deps.sessionStore,
    threadExecutionRegistry: deps.threadExecutionRegistry,
    workspaceResolver: deps.workspaceResolver,
  });
  app.shortcut(
    { callback_id: WORKSPACE_MESSAGE_ACTION_CALLBACK_ID, type: 'message_action' },
    createWorkspaceMessageActionHandler(ingressDeps),
  );
  app.shortcut(
    { callback_id: STOP_MESSAGE_ACTION_CALLBACK_ID, type: 'message_action' },
    createStopMessageActionHandler({
      logger: deps.logger.withTag('slack:stop-action'),
      threadExecutionRegistry: deps.threadExecutionRegistry,
    }),
  );
  app.view(WORKSPACE_MODAL_CALLBACK_ID, createWorkspaceSelectionViewHandler(ingressDeps));
  app.action(WORKSPACE_PICKER_ACTION_ID, createWorkspacePickerActionHandler(ingressDeps) as any);
  app.action(
    PERMISSION_APPROVE_ACTION_ID,
    createPermissionActionHandler(deps.permissionBridge, true) as any,
  );
  app.action(
    PERMISSION_DENY_ACTION_ID,
    createPermissionActionHandler(deps.permissionBridge, false) as any,
  );
  app.action('open_review_panel', async ({ ack }) => {
    await ack();
  });

  app.error(async (error) => {
    deps.logger.error('Slack Bolt unhandled error: %s', redactUnknown(error));
  });

  const kaguraApp = app as KaguraSlackApp;
  kaguraApp.dispatchThreadConversation = (input) =>
    dispatchThreadConversation(app.client as unknown as SlackWebClientLike, ingressDeps, input);
  kaguraApp.startA2ASummaryPoller = () => {
    stopA2ASummaryPoller ??= startA2ASummaryPoller(
      app.client as unknown as SlackWebClientLike,
      ingressDeps,
    );
  };
  kaguraApp.stopA2ASummaryPoller = () => {
    stopA2ASummaryPoller?.();
    stopA2ASummaryPoller = undefined;
  };
  kaguraApp.recoverPendingExecutions = () =>
    recoverPendingExecutions(app.client as unknown as SlackWebClientLike, ingressDeps);
  return kaguraApp;
}
