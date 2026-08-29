import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppLogger } from '~/logger/index.js';
import { rotateToken, syncSlashCommands } from '~/slack/commands/manifest-sync.js';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function createTestLogger(): AppLogger {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
    withTag: vi.fn(),
  };
  logger.withTag.mockReturnValue(logger);
  return logger as unknown as AppLogger;
}

function slackOk<T>(data: T): Response {
  return new Response(JSON.stringify({ ok: true, ...data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function slackError(error: string): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fetchAuthBearer(init: RequestInit): string | undefined {
  const headers = init.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get('Authorization') ?? undefined;
  if (Array.isArray(headers)) {
    const pair = headers.find(([k]) => k.toLowerCase() === 'authorization');
    return pair?.[1];
  }
  return (headers as Record<string, string>).Authorization;
}

function readBodySearchParams(init: RequestInit): URLSearchParams {
  const body = init.body;
  if (body instanceof URLSearchParams) {
    return body;
  }
  return new URLSearchParams(String(body ?? ''));
}

afterEach(() => {
  fetchMock.mockReset();
});

describe('rotateToken', () => {
  it('returns new tokens on success', async () => {
    fetchMock.mockResolvedValueOnce(
      slackOk({
        token: 'xoxe.xoxp-new-access',
        refresh_token: 'xoxe-new-refresh',
        exp: 1700000000,
        iat: 1699956800,
      }),
    );

    const result = await rotateToken('xoxe.xoxp-current-access', 'xoxe-old-refresh');

    expect(result).toBeDefined();
    expect(result!.token).toBe('xoxe.xoxp-new-access');
    expect(result!.refresh_token).toBe('xoxe-new-refresh');
    expect(fetchMock).toHaveBeenCalledOnce();

    const firstFetch = fetchMock.mock.calls[0];
    expect(firstFetch).toBeDefined();
    const [url, init] = firstFetch as [string, RequestInit];
    expect(url).toBe('https://slack.com/api/tooling.tokens.rotate');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded; charset=utf-8',
    );
    const body = readBodySearchParams(init);
    expect(body.get('token')).toBe('xoxe.xoxp-current-access');
    expect(body.get('refresh_token')).toBe('xoxe-old-refresh');
  });

  it('returns undefined on invalid refresh token', async () => {
    fetchMock.mockResolvedValueOnce(slackError('invalid_refresh_token'));

    const result = await rotateToken('xoxe.xoxp-current-access', 'xoxe-bad-token');
    expect(result).toBeUndefined();
  });

  it('returns undefined on network error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network error'));

    const result = await rotateToken('xoxe.xoxp-current-access', 'xoxe-refresh');
    expect(result).toBeUndefined();
  });
});

describe('syncSlashCommands with token rotation', () => {
  it('uses persisted token if not expired', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-sync-'));
    const tokenStorePath = path.join(tmpDir, 'tokens.json');
    const futureExp = Math.floor(Date.now() / 1000) + 3600;

    fs.writeFileSync(
      tokenStorePath,
      JSON.stringify({
        accessToken: 'xoxe.xoxp-persisted',
        refreshToken: 'xoxe-persisted-refresh',
        expiresAt: futureExp,
        updatedAt: new Date().toISOString(),
      }),
    );

    fetchMock.mockResolvedValueOnce(
      slackOk({
        manifest: {
          features: {
            agent_view: { agent_description: 'existing' },
            app_home: { home_tab_enabled: true },
            bot_user: { display_name: 'cc-001', always_online: true },
            slash_commands: [
              { command: '/usage', description: 'test' },
              { command: '/workspace', description: 'test' },
              { command: '/memory', description: 'test' },
              { command: '/session', description: 'test' },
              { command: '/provider', description: 'test' },
              { command: '/model', description: 'test' },
              { command: '/version', description: 'test' },
            ],
            shortcuts: [
              {
                name: 'Stop Reply',
                type: 'message',
                callback_id: 'stop_reply_action',
                description: 'test',
              },
            ],
          },
          settings: {
            event_subscriptions: {
              bot_events: [
                'agent_session_stopped',
                'app_home_opened',
                'message.channels',
                'message.groups',
                'message.im',
              ],
            },
          },
        },
      }),
    );

    const logger = createTestLogger();
    await syncSlashCommands({
      appId: 'A123',
      logger,
      tokenStorePath,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const persistedCall = fetchMock.mock.calls[0];
    expect(persistedCall).toBeDefined();
    const [, init] = persistedCall as [string, RequestInit];
    expect(fetchAuthBearer(init)).toBe('Bearer xoxe.xoxp-persisted');
  });

  it('rotates token when persisted token is expired', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-sync-expired-'));
    const tokenStorePath = path.join(tmpDir, 'tokens.json');
    const pastExp = Math.floor(Date.now() / 1000) - 100;

    fs.writeFileSync(
      tokenStorePath,
      JSON.stringify({
        accessToken: 'xoxe.xoxp-expired',
        refreshToken: 'xoxe-stored-refresh',
        expiresAt: pastExp,
        updatedAt: new Date().toISOString(),
      }),
    );

    fetchMock
      .mockResolvedValueOnce(
        slackOk({
          token: 'xoxe.xoxp-rotated',
          refresh_token: 'xoxe-rotated-refresh',
          exp: Math.floor(Date.now() / 1000) + 43200,
        }),
      )
      .mockResolvedValueOnce(
        slackOk({
          manifest: {
            features: {
              agent_view: { agent_description: 'existing' },
              app_home: { home_tab_enabled: true },
              bot_user: { display_name: 'cc-001', always_online: true },
              slash_commands: [
                { command: '/usage', description: 'test' },
                { command: '/workspace', description: 'test' },
                { command: '/memory', description: 'test' },
                { command: '/session', description: 'test' },
                { command: '/provider', description: 'test' },
                { command: '/model', description: 'test' },
                { command: '/version', description: 'test' },
              ],
              shortcuts: [
                {
                  name: 'Stop Reply',
                  type: 'message',
                  callback_id: 'stop_reply_action',
                  description: 'test',
                },
              ],
            },
            settings: {
              event_subscriptions: {
                bot_events: [
                  'agent_session_stopped',
                  'app_home_opened',
                  'message.channels',
                  'message.groups',
                  'message.im',
                ],
              },
            },
          },
        }),
      );

    const logger = createTestLogger();
    await syncSlashCommands({
      appId: 'A123',
      logger,
      tokenStorePath,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const rotateCall = fetchMock.mock.calls[0];
    expect(rotateCall).toBeDefined();
    const [rotateUrl] = rotateCall as [string, RequestInit];
    expect(rotateUrl).toBe('https://slack.com/api/tooling.tokens.rotate');

    const manifestCall = fetchMock.mock.calls[1];
    expect(manifestCall).toBeDefined();
    const [, manifestInit] = manifestCall as [string, RequestInit];
    expect(fetchAuthBearer(manifestInit)).toBe('Bearer xoxe.xoxp-rotated');

    const updated = JSON.parse(fs.readFileSync(tokenStorePath, 'utf8'));
    expect(updated.accessToken).toBe('xoxe.xoxp-rotated');
    expect(updated.refreshToken).toBe('xoxe-rotated-refresh');
  });

  it('prefers the latest persisted access token for rotation', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-sync-prefer-stored-'));
    const tokenStorePath = path.join(tmpDir, 'tokens.json');
    const pastExp = Math.floor(Date.now() / 1000) - 100;

    fs.writeFileSync(
      tokenStorePath,
      JSON.stringify({
        accessToken: 'xoxe.xoxp-stored-latest',
        refreshToken: 'xoxe-stored-refresh',
        expiresAt: pastExp,
        updatedAt: new Date().toISOString(),
      }),
    );

    fetchMock
      .mockResolvedValueOnce(
        slackOk({
          token: 'xoxe.xoxp-rotated',
          refresh_token: 'xoxe-rotated-refresh',
          exp: Math.floor(Date.now() / 1000) + 43200,
        }),
      )
      .mockResolvedValueOnce(
        slackOk({
          manifest: {
            features: {
              bot_user: { display_name: 'cc-001', always_online: true },
              slash_commands: [
                { command: '/usage', description: 'test' },
                { command: '/workspace', description: 'test' },
                { command: '/memory', description: 'test' },
                { command: '/session', description: 'test' },
                { command: '/provider', description: 'test' },
                { command: '/model', description: 'test' },
              ],
              shortcuts: [
                {
                  name: 'Stop Reply',
                  type: 'message',
                  callback_id: 'stop_reply_action',
                  description: 'test',
                },
              ],
            },
          },
        }),
      );

    const logger = createTestLogger();
    await syncSlashCommands({
      appId: 'A123',
      configToken: 'xoxe.xoxp-env-stale',
      logger,
      tokenStorePath,
    });

    const rotateCall = fetchMock.mock.calls[0];
    expect(rotateCall).toBeDefined();
    const [, init] = rotateCall as [string, RequestInit];
    const body = readBodySearchParams(init);
    expect(body.get('token')).toBe('xoxe.xoxp-stored-latest');
    expect(body.get('refresh_token')).toBe('xoxe-stored-refresh');
  });

  it('registers missing commands via manifest update', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-sync-register-'));
    const tokenStorePath = path.join(tmpDir, 'tokens.json');

    fetchMock
      .mockResolvedValueOnce(
        slackOk({
          manifest: {
            features: {
              slash_commands: [{ command: '/usage', description: 'existing' }],
            },
          },
        }),
      )
      .mockResolvedValueOnce(slackOk({}));

    const logger = createTestLogger();
    await syncSlashCommands({
      appId: 'A123',
      configToken: 'xoxe.xoxp-direct',
      logger,
      tokenStorePath,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const updateCall = fetchMock.mock.calls[1];
    expect(updateCall).toBeDefined();
    const [updateUrl, updateInit] = updateCall as [string, RequestInit];
    expect(updateUrl).toBe('https://slack.com/api/apps.manifest.update');

    const body = JSON.parse(updateInit.body as string);
    const commands = body.manifest.features.slash_commands;
    expect(commands).toHaveLength(7);
    expect(commands.map((c: { command: string }) => c.command)).toEqual(
      expect.arrayContaining([
        '/usage',
        '/workspace',
        '/memory',
        '/session',
        '/provider',
        '/model',
        '/version',
      ]),
    );
    const shortcuts = body.manifest.features.shortcuts;
    expect(shortcuts).toHaveLength(1);
    expect(shortcuts[0].callback_id).toBe('stop_reply_action');
    expect(body.manifest.features.bot_user.always_online).toBe(true);
  });

  it('skips update when all commands, shortcuts, and required bot events exist', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-sync-noop-'));
    const tokenStorePath = path.join(tmpDir, 'tokens.json');

    fetchMock.mockResolvedValueOnce(
      slackOk({
        manifest: {
          features: {
            agent_view: { agent_description: 'existing' },
            app_home: { home_tab_enabled: true },
            bot_user: { display_name: 'cc-001', always_online: true },
            slash_commands: [
              { command: '/usage', description: 'x' },
              { command: '/workspace', description: 'x' },
              { command: '/memory', description: 'x' },
              { command: '/session', description: 'x' },
              { command: '/provider', description: 'x' },
              { command: '/model', description: 'x' },
              { command: '/version', description: 'x' },
            ],
            shortcuts: [
              {
                name: 'Stop Reply',
                type: 'message',
                callback_id: 'stop_reply_action',
                description: 'x',
              },
            ],
          },
          settings: {
            event_subscriptions: {
              bot_events: [
                'agent_session_stopped',
                'app_home_opened',
                'message.channels',
                'message.groups',
                'message.im',
              ],
            },
          },
        },
      }),
    );

    const logger = createTestLogger();
    await syncSlashCommands({
      appId: 'A123',
      configToken: 'xoxe.xoxp-token',
      logger,
      tokenStorePath,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('adds missing bot message events via manifest update', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-sync-missing-events-'));
    const tokenStorePath = path.join(tmpDir, 'tokens.json');

    fetchMock
      .mockResolvedValueOnce(
        slackOk({
          manifest: {
            features: {
              agent_view: { agent_description: 'existing' },
              app_home: { home_tab_enabled: true },
              bot_user: { display_name: 'cc-001', always_online: true },
              slash_commands: [
                { command: '/usage', description: 'x' },
                { command: '/workspace', description: 'x' },
                { command: '/memory', description: 'x' },
                { command: '/session', description: 'x' },
                { command: '/provider', description: 'x' },
                { command: '/model', description: 'x' },
                { command: '/version', description: 'x' },
              ],
              shortcuts: [
                {
                  name: 'Stop Reply',
                  type: 'message',
                  callback_id: 'stop_reply_action',
                  description: 'x',
                },
              ],
            },
            oauth_config: {
              scopes: {
                bot: ['app_mentions:read', 'chat:write', 'channels:history'],
              },
            },
            settings: {
              event_subscriptions: { bot_events: ['app_home_opened', 'app_mention'] },
            },
          },
        }),
      )
      .mockResolvedValueOnce(slackOk({}));

    const logger = createTestLogger();
    await syncSlashCommands({
      appId: 'A123',
      configToken: 'xoxe.xoxp-token',
      logger,
      tokenStorePath,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const updateCall = fetchMock.mock.calls[1];
    expect(updateCall).toBeDefined();
    const [, updateInit] = updateCall as [string, RequestInit];
    const body = JSON.parse(updateInit.body as string);
    expect(body.manifest.settings.event_subscriptions.bot_events).toEqual(
      expect.arrayContaining([
        'agent_session_stopped',
        'app_home_opened',
        'message.channels',
        'message.groups',
        'message.im',
      ]),
    );
    expect(body.manifest.settings.event_subscriptions.bot_events).not.toContain('app_mention');
    expect(body.manifest.oauth_config.scopes.bot).toEqual(['chat:write', 'channels:history']);
  });

  it('enables always_online when bot_user has it disabled', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-sync-presence-'));
    const tokenStorePath = path.join(tmpDir, 'tokens.json');

    fetchMock
      .mockResolvedValueOnce(
        slackOk({
          manifest: {
            features: {
              bot_user: { display_name: 'cc-001', always_online: false },
              slash_commands: [
                { command: '/usage', description: 'x' },
                { command: '/workspace', description: 'x' },
                { command: '/memory', description: 'x' },
                { command: '/session', description: 'x' },
                { command: '/provider', description: 'x' },
                { command: '/model', description: 'x' },
                { command: '/version', description: 'x' },
              ],
              shortcuts: [
                {
                  name: 'Stop Reply',
                  type: 'message',
                  callback_id: 'stop_reply_action',
                  description: 'x',
                },
              ],
            },
          },
        }),
      )
      .mockResolvedValueOnce(slackOk({}));

    const logger = createTestLogger();
    await syncSlashCommands({
      appId: 'A123',
      configToken: 'xoxe.xoxp-token',
      logger,
      tokenStorePath,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const updateCall = fetchMock.mock.calls[1];
    expect(updateCall).toBeDefined();
    const [, updateInit] = updateCall as [string, RequestInit];
    const body = JSON.parse(updateInit.body as string);
    expect(body.manifest.features.bot_user.always_online).toBe(true);
    expect(body.manifest.features.bot_user.display_name).toBe('cc-001');

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('always_online'));
  });

  it('logs error when no tokens available', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-sync-notoken-'));
    const tokenStorePath = path.join(tmpDir, 'tokens.json');

    const logger = createTestLogger();
    await syncSlashCommands({
      appId: 'A123',
      logger,
      tokenStorePath,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('No valid config token'));
  });
  it('migrates a deprecated assistant_view app to agent_view', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-sync-agent-view-'));
    const tokenStorePath = path.join(tmpDir, 'tokens.json');

    fetchMock
      .mockResolvedValueOnce(
        slackOk({
          manifest: {
            features: {
              assistant_view: { assistant_description: 'legacy' },
              app_home: { home_tab_enabled: true },
              bot_user: { display_name: 'cc-001', always_online: true },
              slash_commands: [],
              shortcuts: [],
            },
            oauth_config: { scopes: { bot: ['chat:write'] } },
            settings: {
              event_subscriptions: {
                bot_events: [
                  'agent_session_stopped',
                  'app_home_opened',
                  'message.channels',
                  'message.groups',
                  'message.im',
                ],
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(slackOk({}));

    const logger = createTestLogger();
    await syncSlashCommands({
      appId: 'A123',
      configToken: 'xoxe.xoxp-token',
      logger,
      tokenStorePath,
    });

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('deprecated assistant_view'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, updateInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(updateInit.body as string);
    expect(body.manifest.features.agent_view.agent_description).toEqual(expect.any(String));
    expect(body.manifest.features.agent_view.suggested_prompts).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: expect.any(String) })]),
    );
  });
});
