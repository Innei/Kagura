import { createApplication, type RuntimeApplicationOptions } from '~/application.js';

import type { LiveE2EProviderId } from './scenario.js';

const PROVIDER_IDS = new Set<LiveE2EProviderId>(['claude-code', 'codex-cli', 'pi-agent']);

export function createLiveApplication(options: RuntimeApplicationOptions = {}) {
  const providerId = resolveLiveProviderOverride();
  if (!providerId || options.defaultProviderId) {
    return createApplication(options);
  }

  return createApplication({ ...options, defaultProviderId: providerId });
}

export function resolveLiveProviderOverride(): LiveE2EProviderId | undefined {
  const raw = process.env.SLACK_E2E_PROVIDER_ID?.trim();
  if (!raw) {
    return undefined;
  }
  if (PROVIDER_IDS.has(raw as LiveE2EProviderId)) {
    return raw as LiveE2EProviderId;
  }
  throw new Error(
    `Unsupported SLACK_E2E_PROVIDER_ID "${raw}". Expected one of: ${[...PROVIDER_IDS].join(', ')}`,
  );
}
