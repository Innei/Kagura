import { claudeProvider } from './claude.js';
import { codexProvider } from './codex.js';
import { piAgentProvider } from './pi-agent.js';
import type { ProviderId, ProviderSetup } from './types.js';

const byId: Record<ProviderId, ProviderSetup> = {
  'claude-code': claudeProvider,
  'codex-cli': codexProvider,
  'pi-agent': piAgentProvider,
};

export function listProviders(): ProviderSetup[] {
  return Object.values(byId).sort((a, b) => a.order - b.order);
}

export function getProvider(id: ProviderId): ProviderSetup {
  const p = byId[id];
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}
