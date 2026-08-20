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

describe('slack onboarding · reuse app', () => {
  let tmp: string;
  const origEnv = { ...process.env };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-sr-'));
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
  });

  afterEach(() => {
    process.env = { ...origEnv };
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('collects 4 values without opening a browser', async () => {
    clack.select.mockResolvedValueOnce('reuse');
    clack.text.mockResolvedValueOnce('A300');
    clack.password
      .mockResolvedValueOnce('sig-300')
      .mockResolvedValueOnce('xoxb-reuse')
      .mockResolvedValueOnce('xapp-reuse');
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    await runSlackOnboarding(makePaths(tmp), { allowSkip: false });

    expect(openMock).not.toHaveBeenCalled();
    const env = fs.readFileSync(path.join(tmp, '.env'), 'utf8');
    expect(env).toContain('SLACK_APP_ID=A300');
    expect(env).toContain('SLACK_SIGNING_SECRET=sig-300');
    expect(env).toContain('SLACK_BOT_TOKEN=xoxb-reuse');
    expect(env).toContain('SLACK_APP_TOKEN=xapp-reuse');
  });
});
