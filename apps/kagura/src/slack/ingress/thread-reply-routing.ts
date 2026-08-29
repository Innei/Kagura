import { runtimeError, runtimeInfo, runtimeWarn } from '~/logger/runtime.js';
import type { SlackMessage } from '~/schemas/slack/message.js';

import type { SlackWebClientLike } from '../types.js';
import { resolveMentionCoordinationDecision } from './agent-team-routing.js';
import { dispatchThreadConversation } from './conversation-dispatch.js';
import {
  type A2AThreadContext,
  buildA2AThreadContext,
  getA2AContextFromSession,
} from './scenarios/a2a/routing.js';
import { persistA2ASession } from './scenarios/a2a/session.js';
import { scheduleReadyA2ASummaryCheck } from './scenarios/a2a/summary-runner.js';
import { resolveA2AThreadReplyRoute } from './scenarios/a2a/thread-reply-route.js';
import {
  resolveGeneralThreadReplyRoute,
  resolveRootMessageRoute,
} from './scenarios/general/thread-reply-route.js';
import type {
  CommonThreadReplyRoute,
  ThreadReplyIdentity,
} from './scenarios/thread-reply-route-types.js';
import type { SlackIngressDependencies } from './types.js';

type ThreadReplyRoute =
  | CommonThreadReplyRoute
  | {
      action: 'persist-a2a-standby';
      channelId?: string | undefined;
      context?: A2AThreadContext | undefined;
      lead: string;
      logThreadTs: string;
      rootMessageTs: string;
      threadTs: string;
    };

export interface ThreadReplyRoutingOptions {
  rootAddAcknowledgementReaction?: boolean | undefined;
}

export async function resolveThreadReplyRoute(
  client: SlackWebClientLike,
  deps: SlackIngressDependencies,
  message: SlackMessage,
  identity: ThreadReplyIdentity,
  options: ThreadReplyRoutingOptions = {},
): Promise<ThreadReplyRoute> {
  const threadTs = message.thread_ts;
  // Under agent_view an agent DM arrives as an ordinary message with no
  // mention, so a direct message is addressed to this app by construction.
  const isDirectMessage = message.channel_type === 'im';
  const mentionsCurrentBot = isDirectMessage || mentionsUser(message.text, identity.botUserId);
  const coordinationDecision = resolveMentionCoordinationDecision(
    message.text,
    {
      userId: identity.botUserId,
      userName: identity.botUserName,
    },
    deps.agentTeams,
  );
  const rootA2AContext = buildA2AThreadContext(message.text, coordinationDecision, deps.agentTeams);

  if (coordinationDecision.action === 'standby') {
    return {
      action: 'persist-a2a-standby',
      channelId: typeof message.channel === 'string' ? message.channel : undefined,
      context: !threadTs ? rootA2AContext : undefined,
      lead: coordinationDecision.lead,
      logThreadTs: threadTs ?? message.ts,
      rootMessageTs: message.ts,
      threadTs: message.ts,
    };
  }

  if (!threadTs) {
    const route = resolveRootMessageRoute(deps, message, identity, {
      addAcknowledgementReaction: isDirectMessage
        ? false
        : (options.rootAddAcknowledgementReaction ?? true),
      shouldRun: coordinationDecision.action === 'run' || mentionsCurrentBot,
    });
    if (!rootA2AContext || route.action !== 'dispatch') {
      return route;
    }
    return {
      ...route,
      input: {
        ...route.input,
        a2aContext: rootA2AContext,
        ...(deps.providerRegistry
          ? { agentProviderOverride: deps.providerRegistry.defaultProviderId }
          : {}),
      },
    };
  }

  const session = deps.sessionStore.get(threadTs);
  const a2aContext = session ? getA2AContextFromSession(session) : undefined;
  if (!session && !mentionsCurrentBot && coordinationDecision.action !== 'run') {
    runtimeWarn(
      deps.logger,
      'Ignoring thread reply %s in thread %s because no persisted session was found',
      message.ts,
      threadTs,
    );
    return { action: 'ignore' };
  }

  const channelId =
    typeof message.channel === 'string' && message.channel.trim()
      ? message.channel
      : session?.channelId;
  const teamId = typeof message.team === 'string' ? message.team : undefined;
  if (!channelId) {
    runtimeError(deps.logger, 'Skipping thread reply without channel id for thread %s', threadTs);
    return { action: 'ignore' };
  }
  if (typeof message.channel !== 'string' || !message.channel.trim()) {
    runtimeWarn(
      deps.logger,
      'Thread reply missing channel id for thread %s; falling back to session channel %s',
      threadTs,
      session?.channelId,
    );
  }
  if (!teamId) {
    runtimeWarn(
      deps.logger,
      'Thread reply missing team id for thread %s; continuing without it',
      threadTs,
    );
  }

  const senderId = message.user?.trim() || message.bot_id?.trim();
  if (!senderId) {
    runtimeWarn(
      deps.logger,
      'Ignoring thread reply %s in thread %s because sender id is missing',
      message.ts,
      threadTs,
    );
    return { action: 'ignore' };
  }

  const botAuthored = Boolean(message.bot_id) || message.subtype === 'bot_message';
  if (a2aContext) {
    return resolveA2AThreadReplyRoute(client, deps, {
      a2aContext,
      botAuthored,
      channelId,
      identity,
      message,
      senderId,
      session,
      teamId,
      threadTs,
    });
  }

  return resolveGeneralThreadReplyRoute(client, deps, {
    botAuthored,
    channelId,
    coordinationAction: coordinationDecision.action,
    identity,
    message,
    senderId,
    session,
    teamId,
    threadTs,
  });
}

export async function executeThreadReplyRoute(
  client: SlackWebClientLike,
  deps: SlackIngressDependencies,
  route: ThreadReplyRoute,
): Promise<void> {
  switch (route.action) {
    case 'ignore': {
      scheduleSummaryCheckIfNeeded(client, deps, route);
      return;
    }
    case 'persist-a2a-standby': {
      if (route.context && route.channelId) {
        persistA2ASession(deps, {
          channelId: route.channelId,
          context: route.context,
          rootMessageTs: route.rootMessageTs,
          threadTs: route.threadTs,
        });
      }
      runtimeInfo(
        deps.logger,
        'Skipping thread reply for thread %s because current bot is standby for lead %s',
        route.logThreadTs,
        route.lead,
      );
      return;
    }
    case 'dispatch': {
      scheduleSummaryCheckIfNeeded(client, deps, route);
      await dispatchThreadConversation(client, deps, route.input);
    }
  }
}

function scheduleSummaryCheckIfNeeded(
  client: SlackWebClientLike,
  deps: SlackIngressDependencies,
  route: Extract<ThreadReplyRoute, { action: 'dispatch' | 'ignore' }>,
): void {
  if (!route.summaryCheck) {
    return;
  }
  scheduleReadyA2ASummaryCheck(client, deps, route.summaryCheck.session, {
    currentBotUserId: route.summaryCheck.identity.botUserId,
    currentBotUserName: route.summaryCheck.identity.botUserName,
  });
}

function mentionsUser(messageText: string, userId: string | undefined): boolean {
  return Boolean(userId && messageText.includes(`<@${userId}>`));
}
