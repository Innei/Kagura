import { execFileSync } from 'node:child_process';

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
  const defaultModel = getDefaultModelForProvider(currentProviderId);
  const availableModels = listAvailableModelsForProvider(currentProviderId);
  const lines = [
    `*Available Models for \`${currentProviderId}\`*`,
    '',
    `• *Default:* ${defaultModel ? `\`${defaultModel}\`` : '_provider default_'}`,
  ];

  if (threadTs) {
    lines.push(
      '',
      session?.agentModel
        ? `• *This thread override:* \`${session.agentModel}\``
        : '• *This thread override:* _none_',
    );
  }

  lines.push('');

  if (availableModels.models.length > 0) {
    const visibleModels = availableModels.models.slice(0, 40);
    lines.push(...visibleModels.map((model) => `• \`${model}\``));
    if (availableModels.models.length > visibleModels.length) {
      lines.push(`• _...and ${availableModels.models.length - visibleModels.length} more_`);
    }
  } else {
    lines.push('• _No model catalog available for this provider._');
  }

  if (availableModels.note) {
    lines.push('', `_${availableModels.note}_`);
  }
  lines.push('', '_Set one with `/model <name>`._');
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

function listAvailableModelsForProvider(providerId: string): { models: string[]; note?: string } {
  const configured = getDefaultModelForProvider(providerId);
  switch (providerId) {
    case 'pi-agent': {
      const result = listPiAgentModels();
      return {
        models: mergeModels(result.models, configured),
        ...(result.note ? { note: result.note } : {}),
      };
    }
    case 'codex-cli': {
      const result = listCodexModels();
      return {
        models: mergeModels(result.models, configured),
        ...(result.note ? { note: result.note } : {}),
      };
    }
    case 'claude-code': {
      return {
        models: mergeModels(
          [
            'sonnet',
            'opus',
            'haiku',
            'claude-sonnet-4-5-20250929',
            'claude-opus-4-5-20251101',
            'claude-haiku-4-5-20251001',
          ],
          configured,
        ),
        note: 'Claude Code does not expose a local model catalog command; showing supported aliases, common full IDs, and the configured default.',
      };
    }
    default: {
      return { models: mergeModels([], configured) };
    }
  }
}

function listPiAgentModels(): { models: string[]; note?: string } {
  try {
    const output = execFileSync(env.PI_AGENT_COMMAND, ['--list-models'], {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 512 * 1024,
    });
    const models = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.startsWith('provider '))
      .map((line) => line.split(/\s+/))
      .flatMap((parts) => {
        const provider = parts[0];
        const model = parts[1];
        return provider && model ? [`${provider}/${model}`] : [];
      });
    return { models: uniqueModels(models) };
  } catch {
    return {
      models: [],
      note: `Could not query \`${env.PI_AGENT_COMMAND} --list-models\`; showing configured default only.`,
    };
  }
}

function listCodexModels(): { models: string[]; note?: string } {
  try {
    const output = execFileSync('codex', ['debug', 'models'], {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const parsed = JSON.parse(output) as {
      models?: Array<{ slug?: unknown; visibility?: unknown }>;
    };
    const models = (parsed.models ?? [])
      .filter((model) => model.visibility === undefined || model.visibility === 'list')
      .flatMap((model) => (typeof model.slug === 'string' ? [model.slug] : []));
    return { models: uniqueModels(models) };
  } catch {
    return {
      models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2'],
      note: 'Could not query `codex debug models`; showing built-in fallback models.',
    };
  }
}

function mergeModels(models: string[], configured: string | undefined): string[] {
  return uniqueModels([...(configured ? [configured] : []), ...models]);
}

function uniqueModels(models: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const model of models) {
    const trimmed = model.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}
