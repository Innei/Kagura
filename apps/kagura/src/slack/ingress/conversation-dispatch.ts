import { renameAgentSession, setAgentSessionStatus } from '../agent-sessions.js';
import type { SlackWebClientLike } from '../types.js';
import { handleThreadConversation } from './conversation-pipeline.js';
import { fallbackThreadTitle } from './thread-title-generator.js';
import type {
  SlackIngressDependencies,
  ThreadConversationMessage,
  ThreadConversationOptions,
} from './types.js';

export interface ConversationDispatchInput {
  a2aAssignmentId?: string | undefined;
  a2aContext?: ThreadConversationOptions['a2aContext'];
  a2aSummaryAssignmentId?: string | undefined;
  addAcknowledgementReaction: boolean;
  agentProviderOverride?: string | undefined;
  channelId: string;
  currentBotUserId?: string | undefined;
  currentBotUserName?: string | undefined;
  executionId?: string | undefined;
  files?: ThreadConversationMessage['files'];
  forceNewSession?: boolean;
  logLabel: string;
  messageTs: string;
  resumeHandleOverride?: string | undefined;
  rootMessageTs: string;
  teamId?: string | undefined;
  text: string;
  threadTs?: string | undefined;
  userId: string;
  workspaceOverride?: ThreadConversationOptions['workspaceOverride'];
}

export async function dispatchThreadConversation(
  client: SlackWebClientLike,
  deps: SlackIngressDependencies,
  input: ConversationDispatchInput,
): Promise<void> {
  const message: ThreadConversationMessage = {
    channel: input.channelId,
    text: input.text,
    ts: input.messageTs,
    user: input.userId,
    ...(input.files ? { files: input.files } : {}),
    ...(input.teamId ? { team: input.teamId } : {}),
    ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
  };

  const options: ThreadConversationOptions = {
    addAcknowledgementReaction: input.addAcknowledgementReaction,
    logLabel: input.logLabel,
    rootMessageTs: input.rootMessageTs,
    ...(input.a2aAssignmentId ? { a2aAssignmentId: input.a2aAssignmentId } : {}),
    ...(input.a2aContext ? { a2aContext: input.a2aContext } : {}),
    ...(input.a2aSummaryAssignmentId
      ? { a2aSummaryAssignmentId: input.a2aSummaryAssignmentId }
      : {}),
    ...(input.agentProviderOverride ? { agentProviderOverride: input.agentProviderOverride } : {}),
    ...(input.currentBotUserId ? { currentBotUserId: input.currentBotUserId } : {}),
    ...(input.currentBotUserName ? { currentBotUserName: input.currentBotUserName } : {}),
    ...(input.executionId ? { executionId: input.executionId } : {}),
    ...(input.forceNewSession !== undefined ? { forceNewSession: input.forceNewSession } : {}),
    ...(input.resumeHandleOverride ? { resumeHandleOverride: input.resumeHandleOverride } : {}),
    ...(input.workspaceOverride ? { workspaceOverride: input.workspaceOverride } : {}),
  };

  await nameNewAgentSession(client, deps, input);
  await handleThreadConversation(client, message, deps, options);
}

// The first turn names the Slack agent session so it is recognizable in the
// sessions timeline and thread header.
async function nameNewAgentSession(
  client: SlackWebClientLike,
  deps: SlackIngressDependencies,
  input: ConversationDispatchInput,
): Promise<void> {
  const threadTs = input.threadTs ?? input.rootMessageTs;
  if (deps.sessionStore.get(threadTs)) {
    return;
  }

  let title = fallbackThreadTitle({ text: input.text, files: input.files });
  if (deps.threadTitleGenerator) {
    try {
      title =
        (await deps.threadTitleGenerator.generate({ text: input.text, files: input.files })) ??
        title;
    } catch (error) {
      deps.logger.warn(
        'Failed to generate agent session title for thread %s: %s',
        threadTs,
        String(error),
      );
    }
  }

  if (!title) {
    return;
  }

  await renameAgentSession(client, {
    channelId: input.channelId,
    threadTs,
    title,
  }).catch((error: unknown) => {
    deps.logger.warn('Failed to name agent session for thread %s: %s', threadTs, String(error));
  });

  await setAgentSessionStatus(client, {
    channelId: input.channelId,
    status: 'processing',
    threadTs,
  }).catch((error: unknown) => {
    deps.logger.warn(
      'Failed to set initial agent session status for thread %s: %s',
      threadTs,
      String(error),
    );
  });
}
