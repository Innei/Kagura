import { env } from '~/env/server.js';

import type { SlashCommandDependencies, SlashCommandResponse } from './types.js';

export interface ModelCommandDependencies extends SlashCommandDependencies {
  channelId?: string | undefined;
  threadTs?: string | undefined;
}

export function handleModelCommand(
  text: string,
  deps: ModelCommandDependencies,
): SlashCommandResponse {
  const trimmed = text.trim();
  const subcommand = trimmed.toLowerCase();

  if (!trimmed || subcommand === 'status') {
    return showModelStatus(deps);
  }

  if (subcommand === 'list') {
    return listModels(deps);
  }

  if (subcommand === 'reset') {
    return resetModel(deps);
  }

  return setModel(trimmed, deps);
}

function showModelStatus(deps: ModelCommandDependencies): SlashCommandResponse {
  const { providerRegistry, sessionStore, threadTs } = deps;
  const session = threadTs ? sessionStore.get(threadTs) : undefined;
  const providerId = session?.agentProvider ?? providerRegistry.defaultProviderId;
  const threadModel = session?.agentModel;
  const defaultModel = getDefaultModelForProvider(providerId);
  const lines = [
    '*Agent Model Status*',
    '',
    `• *Provider:* \`${providerId}\``,
    `• *Default:* ${defaultModel ? `\`${defaultModel}\`` : '_provider default_'}`,
  ];

  if (threadTs) {
    lines.push(
      threadModel ? `• *This thread:* \`${threadModel}\`` : '• *This thread:* using default',
    );
  } else {
    lines.push('', '_Use `/model <name>` in a thread to switch model for that thread._');
  }

  return { response_type: 'ephemeral', text: lines.join('\n') };
}

function listModels(deps: ModelCommandDependencies): SlashCommandResponse {
  const { providerRegistry, sessionStore, threadTs } = deps;
  const session = threadTs ? sessionStore.get(threadTs) : undefined;
  const currentProviderId = session?.agentProvider ?? providerRegistry.defaultProviderId;
  const lines = [
    '*Configured Model Defaults*',
    '',
    ...providerRegistry.providerIds.map((id) => {
      const defaultModel = getDefaultModelForProvider(id);
      const current = id === currentProviderId ? ' _(current provider)_' : '';
      return `• \`${id}\`: ${defaultModel ? `\`${defaultModel}\`` : '_provider default_'}${current}`;
    }),
  ];

  if (threadTs) {
    lines.push(
      '',
      session?.agentModel
        ? `• *This thread override:* \`${session.agentModel}\``
        : '• *This thread override:* _none_',
    );
  }

  lines.push('', '_Set any provider-supported model with `/model <name>`._');
  return { response_type: 'ephemeral', text: lines.join('\n') };
}

function resetModel(deps: ModelCommandDependencies): SlashCommandResponse {
  const { providerRegistry, sessionStore, threadTs } = deps;

  if (!threadTs) {
    return {
      response_type: 'ephemeral',
      text: 'Use `/model reset` inside a thread to clear the per-thread model override.',
    };
  }

  const session = sessionStore.get(threadTs);
  if (!session) {
    return {
      response_type: 'ephemeral',
      text: 'No active session found for this thread.',
    };
  }

  sessionStore.patch(threadTs, {
    agentModel: undefined,
    providerSessionId: undefined,
  });

  const providerId = session.agentProvider ?? providerRegistry.defaultProviderId;
  const defaultModel = getDefaultModelForProvider(providerId);
  return {
    response_type: 'ephemeral',
    text: `Model override cleared for this thread. Will use ${defaultModel ? `\`${defaultModel}\`` : 'the provider default'} on the next message.`,
  };
}

function setModel(model: string, deps: ModelCommandDependencies): SlashCommandResponse {
  const { sessionStore, threadTs } = deps;
  if (!threadTs) {
    return {
      response_type: 'ephemeral',
      text: `Use \`/model ${model}\` inside a thread to switch the model for that thread.`,
    };
  }

  const session = sessionStore.get(threadTs);
  if (!session) {
    return {
      response_type: 'ephemeral',
      text: 'No active session found for this thread. Start a conversation first.',
    };
  }

  sessionStore.patch(threadTs, {
    agentModel: model,
    providerSessionId: undefined,
  });

  return {
    response_type: 'ephemeral',
    text: `Model switched to *${model}* for this thread. The next message will start a fresh provider session with this model.`,
  };
}

function getDefaultModelForProvider(providerId: string): string | undefined {
  switch (providerId) {
    case 'claude-code': {
      return env.CLAUDE_MODEL;
    }
    case 'codex-cli': {
      return env.CODEX_MODEL;
    }
    case 'pi-agent': {
      return env.PI_AGENT_MODEL;
    }
    default: {
      return undefined;
    }
  }
}
