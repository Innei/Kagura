import type { SlackWebClientLike } from './types.js';

const TITLE_MAX_LENGTH = 200;

export type AgentSessionStatus = 'processing' | 'active' | 'suspended' | 'closed';

export interface AgentSessionStatusArgs {
  channelId: string;
  status: AgentSessionStatus;
  threadTs: string;
  title?: string | undefined;
}

// @slack/web-api 7.15.1 has no typed `agents.*` methods yet, so the Agent
// Sessions API is reached through the generic apiCall escape hatch.
export async function setAgentSessionStatus(
  client: SlackWebClientLike,
  args: AgentSessionStatusArgs,
): Promise<void> {
  await client.apiCall('agents.sessions.setStatus', {
    channel_id: args.channelId,
    thread_ts: args.threadTs,
    status: args.status,
  });
}

export interface RenameAgentSessionArgs {
  channelId: string;
  threadTs: string;
  title: string;
}

export async function renameAgentSession(
  client: SlackWebClientLike,
  args: RenameAgentSessionArgs,
): Promise<void> {
  await client.apiCall('agents.sessions.rename', {
    channel_id: args.channelId,
    thread_ts: args.threadTs,
    title: args.title.slice(0, TITLE_MAX_LENGTH),
  });
}
