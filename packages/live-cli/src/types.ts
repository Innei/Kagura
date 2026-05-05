export type LiveE2EProviderId = 'claude-code' | 'codex-cli' | 'pi-agent';

export type LiveE2EProviderRequirement =
  | { kind: 'generic' }
  | { kind: 'specific'; providerId: LiveE2EProviderId; reason?: string | undefined };

export interface LiveE2EScenario {
  description: string;
  id: string;
  keywords: string[];
  provider?: LiveE2EProviderRequirement | undefined;
  run: () => Promise<void>;
  title: string;
}
