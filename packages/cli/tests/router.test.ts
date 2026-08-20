import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../src/index.js';

describe('runCli', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('returns 0 for --version', async () => {
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await runCli(['node', 'kagura', '--version']);
      expect(code).toBe(0);
      expect(out.join('')).toMatch(/@innei\/kagura v/);
    } finally {
      process.stdout.write = write;
    }
  });

  it('returns 0 for --help', async () => {
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await runCli(['node', 'kagura', '--help']);
      expect(code).toBe(0);
      expect(out.join('')).toMatch(/Usage: kagura/);
    } finally {
      process.stdout.write = write;
    }
  });

  it('enables debug environment before starting the app', async () => {
    process.env.LOG_LEVEL = '';
    process.env.DEBUG = '';
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_APP_TOKEN = 'xapp-test';
    process.env.SLACK_SIGNING_SECRET = 'secret';
    process.env.REPO_ROOT_DIR = '/tmp/repos';

    let started = false;
    const code = await runCli(['node', 'kagura', '--debug'], {
      startApp: async () => {
        started = true;
        expect(process.env.KAGURA_DEBUG).toBe('true');
        expect(process.env.LOG_LEVEL).toBe('debug');
        expect(process.env.DEBUG).toBe('kagura:*');
      },
    });

    expect(code).toBe(0);
    expect(started).toBe(true);
  });
});
