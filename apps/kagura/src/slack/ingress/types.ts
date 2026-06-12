import type { AgentProviderRegistry } from '~/agent/registry.js';
import type { AgentExecutor } from '~/agent/types.js';
import type { SessionAnalyticsStore } from '~/analytics/types.js';
import type { ChannelPreferenceStore } from '~/channel-preference/types.js';
import type { AppLogger } from '~/logger/index.js';
import type { MemoryIngestionService } from '~/memory/ingestion/service.js';
import type { ContextMemories, MemoryStore } from '~/memory/types.js';
import type { ReviewSessionStore } from '~/review/types.js';
import type { SessionRecord, SessionStore } from '~/session/types.js';
import type { WorkspaceResolver } from '~/workspace/resolver.js';
import type { ThreadWorkspaceManager } from '~/workspace/thread-worktree.js';
import type { ResolvedWorkspace } from '~/workspace/types.js';

import type {
  NormalizedThreadContext,
  SlackThreadContextLoader,
} from '../context/thread-context-loader.js';
import type { PersistentExecutionStore } from '../execution/persistent-execution-store.js';
import type { ThreadExecutionRegistry } from '../execution/thread-execution-registry.js';
import type { SlackPermissionBridge } from '../interaction/permission-bridge.js';
import type { SlackUserInputBridge } from '../interaction/user-input-bridge.js';
import type { SlackRenderer } from '../render/slack-renderer.js';
import type { SlackWebClientLike } from '../types.js';
import type { A2ACoordinatorStore } from './a2a-coordinator-store.js';
import type { A2AOutputMode, QuietAssistantMessageRecorder } from './a2a-output-diagnostics.js';
import type { AgentTeamsConfig } from './agent-team-routing.js';
import type { A2AThreadContext } from './scenarios/a2a/routing.js';

export interface SlackIngressDependencies {
  a2aCoordinatorStore?: A2ACoordinatorStore | undefined;
  a2aOutputMode?: A2AOutputMode | undefined;
  a2aQuietMessageRecorder?: QuietAssistantMessageRecorder | undefined;
  agentTeams?: AgentTeamsConfig | undefined;
  analyticsStore: SessionAnalyticsStore;
  channelPreferenceStore: ChannelPreferenceStore;
  claudeExecutor: AgentExecutor;
  logger: AppLogger;
  memoryIngestionService?: MemoryIngestionService | undefined;
  memoryStore: MemoryStore;
  permissionBridge?: SlackPermissionBridge;
  persistentExecutionStore?: PersistentExecutionStore | undefined;
  providerRegistry?: AgentProviderRegistry;
  renderer: SlackRenderer;
  reviewPanelBaseUrl?: string | undefined;
  reviewSessionStore?: ReviewSessionStore | undefined;
  sessionStore: SessionStore;
  threadContextLoader: SlackThreadContextLoader;
  threadExecutionRegistry: ThreadExecutionRegistry;
  threadWorkspaceManager?: ThreadWorkspaceManager | undefined;
  userInputBridge: SlackUserInputBridge;
  workspaceResolver: WorkspaceResolver;
}

export interface ThreadConversationMessageFile {
  id: string;
  mimetype?: string | null | undefined;
  name?: string | null | undefined;
  url_private?: string | null | undefined;
}

export interface ThreadConversationMessage {
  channel: string;
  files?: ThreadConversationMessageFile[] | undefined;
  team?: string | undefined;
  text: string;
  thread_ts?: string | undefined;
  ts: string;
  user: string;
}

export interface ThreadConversationOptions {
  a2aAssignmentId?: string | undefined;
  a2aContext?: A2AThreadContext | undefined;
  a2aSummaryAssignmentId?: string | undefined;
  addAcknowledgementReaction: boolean;
  agentProviderOverride?: string | undefined;
  currentBotUserId?: string | undefined;
  currentBotUserName?: string | undefined;
  executionId?: string | undefined;
  forceNewSession?: boolean;
  logLabel: string;
  resumeHandleOverride?: string | undefined;
  rootMessageTs: string;
  workspaceOverride?: ResolvedWorkspace;
}

export interface ConversationPipelineContext {
  client: SlackWebClientLike;
  contextMemories?: ContextMemories | undefined;
  deps: SlackIngressDependencies;
  existingSession?: SessionRecord | undefined;
  message: ThreadConversationMessage;

  options: ThreadConversationOptions;
  previousTurnTriggerTs?: string | undefined;
  resumeHandle?: string | undefined;
  threadContext?: NormalizedThreadContext | undefined;
  threadTs: string;
  workspace?: ResolvedWorkspace | undefined;
}

export type PipelineStepResult = { action: 'continue' } | { action: 'done'; reason: string };

export type PipelineStep = (ctx: ConversationPipelineContext) => Promise<PipelineStepResult>;
