import type { AppLogger } from '~/logger/index.js';

import { setAgentSessionStatus } from '../agent-sessions.js';
import type { ThreadExecutionRegistry } from '../execution/thread-execution-registry.js';
import type { SlackWebClientLike } from '../types.js';

export interface AgentSessionStoppedDependencies {
  logger: AppLogger;
  threadExecutionRegistry: ThreadExecutionRegistry;
}

interface AgentSessionStoppedEvent {
  channel_id?: string;
  thread_ts?: string;
}

export function createAgentSessionStoppedHandler(deps: AgentSessionStoppedDependencies) {
  return async (args: { client: unknown; event: unknown }): Promise<void> => {
    const event = args.event as AgentSessionStoppedEvent;
    const channelId = event.channel_id?.trim();
    const threadTs = event.thread_ts?.trim();
    if (!channelId || !threadTs) {
      return;
    }

    const result = await deps.threadExecutionRegistry.stopByMessage(threadTs, 'user_stop');
    deps.logger.info(
      'Agent session stop in channel %s thread %s: stopped=%d failed=%d',
      channelId,
      threadTs,
      result.stopped,
      result.failed,
    );

    // Slack does not transition the session itself when the user hits stop.
    await setAgentSessionStatus(args.client as SlackWebClientLike, {
      channelId,
      status: 'active',
      threadTs,
    }).catch((error: unknown) => {
      deps.logger.warn(
        'Failed to reset agent session status for thread %s: %s',
        threadTs,
        String(error),
      );
    });
  };
}
