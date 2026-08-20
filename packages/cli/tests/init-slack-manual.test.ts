import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runSlackOnboarding } from '../src/commands/init-slack.js';

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

const clack = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn(() => false),
  select: vi.fn(),
  text: vi.fn(),
  password: vi.fn(),
  confirm: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@clack/prompts', () => clack);
const openMock = vi.hoisted(() => vi.fn());
vi.mock('open', () => ({ default: openMock }));

function makePaths(dir: string) {
  return {
    configDir: dir,
    envFile: path.join(dir, '.env'),
    configJsonFile: path.join(dir, 'config.json'),
    dataDir: path.join(dir, 'data'),
    dbPath: path.join(dir, 'data', 'sessions.db'),
    logDir: path.join(dir, 'logs'),
    pidFile: path.join(dir, 'data', 'kagura.pid'),
    tokenStore: path.join(dir, 'data', 'slack-config-tokens.json'),
  };
}

describe('slack onboarding · new app · manual (no config token)', () => {
  let tmp: string;
  const origEnv = { ...process.env };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-sm-'));
    fetchMock.mockReset();
    openMock.mockReset();
    for (const k of Object.keys(clack) as Array<keyof typeof clack>) {
      const v = clack[k];
      if (typeof v === 'function') (v as ReturnType<typeof vi.fn>).mockReset();
      else if (v && typeof v === 'object') {
        for (const sub of Object.values(v as Record<string, unknown>)) {
          if (typeof sub === 'function') (sub as ReturnType<typeof vi.fn>).mockReset();
        }
      }
    }
    clack.isCancel.mockReturnValue(false);
    process.env = { ...origEnv };
    delete process.env.SLACK_CONFIG_TOKEN;
    delete process.env.SLACK_CONFIG_REFRESH_TOKEN;
  });

  afterEach(() => {
    process.env = { ...origEnv };
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('opens prefill URL, collects 4 pasted values, verifies bot + app token', async () => {
    clack.select.mockResolvedValueOnce('new');
    clack.text.mockResolvedValueOnce('A200'); // SLACK_APP_ID
    clack.password
      .mockResolvedValueOnce('sig-200') // SIGNING_SECRET
      .mockResolvedValueOnce('xoxb-new') // BOT
      .mockResolvedValueOnce('xapp-new'); // APP
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    await runSlackOnboarding(makePaths(tmp), { allowSkip: false });

    expect(openMock).toHaveBeenCalledOnce();
    const env = fs.readFileSync(path.join(tmp, '.env'), 'utf8');
    expect(env).toContain('SLACK_APP_ID=A200');
    expect(env).toContain('SLACK_SIGNING_SECRET=sig-200');
    expect(env).toContain('SLACK_BOT_TOKEN=xoxb-new');
    expect(env).toContain('SLACK_APP_TOKEN=xapp-new');
  });
});
