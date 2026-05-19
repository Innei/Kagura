import fs from 'node:fs';
import path from 'node:path';

import { resolveKaguraPaths } from '@kagura/cli/config/paths';
import {
  DESIRED_BOT_EVENTS,
  DESIRED_COMMANDS,
  DESIRED_SHORTCUTS,
  type SlackManifestShortcut,
  type SlackManifestSlashCommand,
} from '@kagura/cli/slack/manifest-template';

import type { AppLogger } from '~/logger/index.js';

interface SlackManifestBotUser {
  [key: string]: unknown;
  always_online?: boolean;
  display_name?: string;
}

interface SlackManifestAppHome {
  home_tab_enabled?: boolean;
  messages_tab_enabled?: boolean;
  messages_tab_read_only_enabled?: boolean;
}

interface SlackManifestEventSubscriptions {
  [key: string]: unknown;
  bot_events?: string[];
}

interface SlackManifestOAuthConfig {
  [key: string]: unknown;
  scopes?: {
    bot?: string[];
    [key: string]: unknown;
  };
}

interface SlackManifest {
  [key: string]: unknown;
  features?: {
    app_home?: SlackManifestAppHome;
    bot_user?: SlackManifestBotUser;
    shortcuts?: SlackManifestShortcut[];
    slash_commands?: SlackManifestSlashCommand[];
    [key: string]: unknown;
  };
  oauth_config?: SlackManifestOAuthConfig;
  settings?: {
    event_subscriptions?: SlackManifestEventSubscriptions;
    [key: string]: unknown;
  };
}

interface SlackApiResponse<T = unknown> {
  error?: string;
  manifest?: T;
  ok: boolean;
}

interface TokenRotateResponse {
  error?: string;
  exp?: number;
  iat?: number;
  ok: boolean;
  refresh_token?: string;
  token?: string;
}

interface PersistedTokens {
  accessToken: string;
  expiresAt: number;
  refreshToken: string;
  updatedAt: string;
}

export interface ManifestSyncOptions {
  appId: string;
  configToken?: string | undefined;
  logger: AppLogger;
  refreshToken?: string | undefined;
  tokenStorePath?: string | undefined;
}

const OBSOLETE_BOT_EVENTS = ['app_mention'] as const;
const OBSOLETE_BOT_SCOPES = ['app_mentions:read'] as const;
const MANIFEST_SYNC_REQUEST_TIMEOUT_MS = 15_000;

export async function syncSlashCommands(options: ManifestSyncOptions): Promise<void> {
  const { appId, logger } = options;
  const tokenStorePath = options.tokenStorePath ?? resolveKaguraPaths().tokenStore;

  logger.info('Checking slash command registration for app %s...', appId);

  const accessToken = await resolveAccessToken(options, tokenStorePath);
  if (!accessToken) {
    logger.error(
      'No valid config token available — set SLACK_CONFIG_TOKEN or SLACK_CONFIG_REFRESH_TOKEN',
    );
    return;
  }

  const currentManifest = await exportManifest(appId, accessToken);
  if (!currentManifest) {
    logger.error('Failed to export app manifest — skipping slash command sync');
    return;
  }

  const existingCommands = currentManifest.features?.slash_commands ?? [];
  const existingNames = new Set(existingCommands.map((c) => c.command));
  const missingCommands = DESIRED_COMMANDS.filter((c) => !existingNames.has(c.command));

  const existingShortcuts = currentManifest.features?.shortcuts ?? [];
  const existingCallbackIds = new Set(existingShortcuts.map((s) => s.callback_id));
  const missingShortcuts = DESIRED_SHORTCUTS.filter((s) => !existingCallbackIds.has(s.callback_id));

  // Ensure bot_user.always_online is true (required for Socket Mode presence)
  const botUser = currentManifest.features?.bot_user;
  const needsAlwaysOnline = !botUser?.always_online;

  // Ensure home tab is enabled (required for Home tab to render)
  const appHome = currentManifest.features?.app_home;
  const needsHomeTab = !appHome?.home_tab_enabled;

  // Ensure required bot events are subscribed
  const existingBotEvents = currentManifest.settings?.event_subscriptions?.bot_events ?? [];
  const obsoleteBotEvents = existingBotEvents.filter((event) =>
    OBSOLETE_BOT_EVENTS.includes(event as (typeof OBSOLETE_BOT_EVENTS)[number]),
  );
  const botEventsToKeep = existingBotEvents.filter(
    (event) => !OBSOLETE_BOT_EVENTS.includes(event as (typeof OBSOLETE_BOT_EVENTS)[number]),
  );
  const missingBotEvents = DESIRED_BOT_EVENTS.filter((event) => !botEventsToKeep.includes(event));

  const existingBotScopes = currentManifest.oauth_config?.scopes?.bot ?? [];
  const obsoleteBotScopes = existingBotScopes.filter((scope) =>
    OBSOLETE_BOT_SCOPES.includes(scope as (typeof OBSOLETE_BOT_SCOPES)[number]),
  );
  const botScopesToKeep = existingBotScopes.filter(
    (scope) => !OBSOLETE_BOT_SCOPES.includes(scope as (typeof OBSOLETE_BOT_SCOPES)[number]),
  );

  // Remove /stop if still present in manifest (replaced by reaction + shortcut)
  const commandsToKeep = (
    missingCommands.length > 0 ? [...existingCommands, ...missingCommands] : existingCommands
  ).filter((c) => c.command !== '/stop');
  const commandsChanged =
    missingCommands.length > 0 || commandsToKeep.length !== existingCommands.length;

  if (
    !commandsChanged &&
    missingShortcuts.length === 0 &&
    !needsAlwaysOnline &&
    !needsHomeTab &&
    missingBotEvents.length === 0 &&
    obsoleteBotEvents.length === 0 &&
    obsoleteBotScopes.length === 0
  ) {
    logger.info(
      'All %d slash commands and %d shortcuts already registered, bot always_online, home_tab, and required bot events are enabled',
      DESIRED_COMMANDS.length,
      DESIRED_SHORTCUTS.length,
    );
    return;
  }

  if (missingCommands.length > 0) {
    logger.info(
      'Registering %d missing slash commands: %s',
      missingCommands.length,
      missingCommands.map((c) => c.command).join(', '),
    );
  }
  if (missingShortcuts.length > 0) {
    logger.info(
      'Registering %d missing shortcuts: %s',
      missingShortcuts.length,
      missingShortcuts.map((s) => s.name).join(', '),
    );
  }
  if (needsAlwaysOnline) {
    logger.info('Enabling bot_user.always_online for Socket Mode presence');
  }
  if (needsHomeTab) {
    logger.info('Enabling app_home.home_tab_enabled for Home tab');
  }
  if (missingBotEvents.length > 0) {
    logger.info('Adding missing bot events: %s', missingBotEvents.join(', '));
  }
  if (obsoleteBotEvents.length > 0) {
    logger.info('Removing obsolete bot events: %s', obsoleteBotEvents.join(', '));
  }
  if (obsoleteBotScopes.length > 0) {
    logger.info('Removing obsolete bot scopes: %s', obsoleteBotScopes.join(', '));
  }

  const updatedBotEvents = [...botEventsToKeep];
  for (const event of missingBotEvents) {
    if (!updatedBotEvents.includes(event)) {
      updatedBotEvents.push(event);
    }
  }

  const updatedManifest: SlackManifest = {
    ...currentManifest,
    features: {
      ...currentManifest.features,
      app_home: {
        ...currentManifest.features?.app_home,
        home_tab_enabled: true,
      },
      bot_user: {
        ...currentManifest.features?.bot_user,
        always_online: true,
      },
      slash_commands: commandsToKeep,
      shortcuts: [...existingShortcuts, ...missingShortcuts],
    },
    ...(obsoleteBotScopes.length > 0
      ? {
          oauth_config: {
            ...currentManifest.oauth_config,
            scopes: {
              ...currentManifest.oauth_config?.scopes,
              bot: botScopesToKeep,
            },
          },
        }
      : {}),
    settings: {
      ...currentManifest.settings,
      event_subscriptions: {
        ...currentManifest.settings?.event_subscriptions,
        bot_events: updatedBotEvents,
      },
    },
  };

  const success = await updateManifest(appId, accessToken, updatedManifest);
  if (success) {
    logger.info('Manifest updated successfully');
  } else {
    logger.error('Failed to update app manifest');
  }
}

async function resolveAccessToken(
  options: ManifestSyncOptions,
  tokenStorePath: string,
): Promise<string | undefined> {
  const { logger } = options;

  const stored = loadPersistedTokens(tokenStorePath);
  if (stored && stored.expiresAt > Date.now() / 1000 + 300) {
    logger.debug(
      'Using persisted config token (expires at %s)',
      new Date(stored.expiresAt * 1000).toISOString(),
    );
    return stored.accessToken;
  }

  const refreshToken = stored?.refreshToken ?? options.refreshToken;
  const currentConfigToken = stored?.accessToken ?? options.configToken;
  if (refreshToken && currentConfigToken) {
    logger.info('Rotating config token via refresh token...');
    const rotated = await rotateToken(currentConfigToken, refreshToken);
    if (rotated) {
      persistTokens(tokenStorePath, rotated, logger);
      logger.info(
        'Config token rotated successfully (expires at %s)',
        new Date((rotated.exp ?? 0) * 1000).toISOString(),
      );
      return rotated.token;
    }

    if (
      stored?.refreshToken &&
      options.refreshToken &&
      stored.refreshToken !== options.refreshToken
    ) {
      logger.info('Stored refresh token failed, trying env refresh token...');
      const fallback = await rotateToken(currentConfigToken, options.refreshToken);
      if (fallback) {
        persistTokens(tokenStorePath, fallback, logger);
        return fallback.token;
      }
    }

    logger.warn('Token rotation failed');
  }

  if (options.configToken) {
    logger.debug('Falling back to SLACK_CONFIG_TOKEN from env');
    return options.configToken;
  }

  return undefined;
}

export async function rotateToken(
  configToken: string,
  refreshToken: string,
): Promise<TokenRotateResponse | undefined> {
  try {
    const body = new URLSearchParams({
      token: configToken,
      refresh_token: refreshToken,
    });
    const response = await fetch('https://slack.com/api/tooling.tokens.rotate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      },
      body,
    });

    if (!response.ok) {
      return undefined;
    }

    const data = (await response.json()) as TokenRotateResponse;
    if (!data.ok || !data.token || !data.refresh_token) {
      return undefined;
    }

    return data;
  } catch {
    return undefined;
  }
}

function loadPersistedTokens(tokenStorePath: string): PersistedTokens | undefined {
  const absolutePath = path.resolve(process.cwd(), tokenStorePath);
  try {
    const content = fs.readFileSync(absolutePath, 'utf8');
    const parsed = JSON.parse(content) as Partial<PersistedTokens>;
    if (
      typeof parsed.accessToken === 'string' &&
      typeof parsed.refreshToken === 'string' &&
      typeof parsed.expiresAt === 'number'
    ) {
      return parsed as PersistedTokens;
    }
  } catch {
    // File doesn't exist or is invalid — will be created on first rotation.
  }
  return undefined;
}

function persistTokens(
  tokenStorePath: string,
  rotated: TokenRotateResponse,
  logger: AppLogger,
): void {
  if (!rotated.token || !rotated.refresh_token) {
    return;
  }

  const absolutePath = path.resolve(process.cwd(), tokenStorePath);
  const data: PersistedTokens = {
    accessToken: rotated.token,
    refreshToken: rotated.refresh_token,
    expiresAt: rotated.exp ?? Math.floor(Date.now() / 1000) + 43_200,
    updatedAt: new Date().toISOString(),
  };

  try {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    logger.debug('Persisted rotated tokens to %s', absolutePath);
  } catch (error) {
    logger.warn(
      'Failed to persist rotated tokens: %s',
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function exportManifest(
  appId: string,
  configToken: string,
): Promise<SlackManifest | undefined> {
  try {
    const response = await fetch('https://slack.com/api/apps.manifest.export', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${configToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ app_id: appId }),
      signal: AbortSignal.timeout(MANIFEST_SYNC_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      return undefined;
    }

    const data = (await response.json()) as SlackApiResponse<SlackManifest>;
    if (!data.ok || !data.manifest) {
      return undefined;
    }

    return data.manifest;
  } catch {
    return undefined;
  }
}

async function updateManifest(
  appId: string,
  configToken: string,
  manifest: SlackManifest,
): Promise<boolean> {
  try {
    const response = await fetch('https://slack.com/api/apps.manifest.update', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${configToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ app_id: appId, manifest }),
      signal: AbortSignal.timeout(MANIFEST_SYNC_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      return false;
    }

    const data = (await response.json()) as SlackApiResponse;
    return data.ok === true;
  } catch {
    return false;
  }
}
