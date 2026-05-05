import type { AgentProviderRegistry } from '~/agent/registry.js';

import type { SlashCommandDependencies, SlashCommandResponse } from './types.js';

export interface ProviderCommandDependencies extends SlashCommandDependencies {
  channelId?: string | undefined;
  providerRegistry: AgentProviderRegistry;
  threadTs?: string | undefined;
}

export function handleProviderCommand(
  text: string,
  deps: ProviderCommandDependencies,
): SlashCommandResponse {
  const subcommand = text.trim().toLowerCase();

  if (!subcommand || subcommand === 'status') {
    return showProviderStatus(deps);
  }

  if (subcommand === 'list') {
    return listProviders(deps);
  }

  if (subcommand === 'reset') {
    return resetProvider(deps);
  }

  return setProvider(subcommand, deps);
}

function showProviderStatus(deps: ProviderCommandDependencies): SlashCommandResponse {
  const { providerRegistry, sessionStore, threadTs } = deps;
  const lines = [
    `*Agent Provider Status*`,
    '',
    `• *Default:* \`${providerRegistry.defaultProviderId}\``,
    `• *Available:* ${providerRegistry.providerIds.map((id) => `\`${id}\``).join(', ')}`,
  ];

  if (threadTs) {
    const session = sessionStore.get(threadTs);
    const threadProvider = session?.agentProvider;
    lines.push(
      '',
      threadProvider ? `• *This thread:* \`${threadProvider}\`` : '• *This thread:* using default',
    );
  } else {
    lines.push('', '_Use `/provider <id>` in a thread to switch provider for that thread._');
  }

  return { response_type: 'ephemeral', text: lines.join('\n') };
}

function listProviders(deps: ProviderCommandDependencies): SlashCommandResponse {
  const { providerRegistry } = deps;
  const lines = [
    '*Registered Providers*',
    '',
    ...providerRegistry.providerIds.map((id) => {
      const isDefault = id === providerRegistry.defaultProviderId;
      return `• \`${id}\`${isDefault ? ' _(default)_' : ''}`;
    }),
  ];

  return { response_type: 'ephemeral', text: lines.join('\n') };
}

function resetProvider(deps: ProviderCommandDependencies): SlashCommandResponse {
  const { sessionStore, threadTs } = deps;

  if (!threadTs) {
    return {
      response_type: 'ephemeral',
      text: 'Use `/provider reset` inside a thread to clear the per-thread provider override.',
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
    agentProvider: undefined,
    agentModel: undefined,
    providerSessionId: undefined,
  });

  return {
    response_type: 'ephemeral',
    text: `Provider override cleared for this thread. Will use the default (\`${deps.providerRegistry.defaultProviderId}\`).`,
  };
}

function setProvider(providerId: string, deps: ProviderCommandDependencies): SlashCommandResponse {
  const { providerRegistry, sessionStore, threadTs } = deps;

  if (!providerRegistry.has(providerId)) {
    const available = providerRegistry.providerIds.map((id) => `\`${id}\``).join(', ');
    return {
      response_type: 'ephemeral',
      text: `Unknown provider \`${providerId}\`. Available: ${available}`,
    };
  }

  if (!threadTs) {
    return {
      response_type: 'ephemeral',
      text: `Use \`/provider ${providerId}\` inside a thread to switch the provider for that thread.`,
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
    agentProvider: providerId,
    agentModel: undefined,
    providerSessionId: undefined,
  });

  return {
    response_type: 'ephemeral',
    text: `Provider switched to *${providerId}* for this thread. The next message will use the new provider and its default model.`,
  };
}
