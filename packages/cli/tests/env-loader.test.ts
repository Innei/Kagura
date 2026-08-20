import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectConfig, loadConfigJson, loadEnvFile } from '../src/config/env-loader.js';
import type { KaguraPaths } from '../src/config/paths.js';

function makePaths(dir: string): KaguraPaths {
  return {
    configDir: dir,
    configJsonFile: path.join(dir, 'config.json'),
    dataDir: path.join(dir, 'data'),
    dbPath: path.join(dir, 'data', 'sessions.db'),
    envFile: path.join(dir, '.env'),
    logDir: path.join(dir, 'logs'),
    pidFile: path.join(dir, 'data', 'kagura.pid'),
    tokenStore: path.join(dir, 'data', 'slack-config-tokens.json'),
  };
}

describe('env-loader', () => {
  let tmp: string;
  const origEnv = { ...process.env };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kagura-env-'));
    process.env = { ...origEnv };
    for (const k of [
      'SLACK_BOT_TOKEN',
      'SLACK_APP_TOKEN',
      'SLACK_SIGNING_SECRET',
      'REPO_ROOT_DIR',
    ]) {
      delete process.env[k];
    }
  });

  afterEach(() => {
    process.env = { ...origEnv };
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('loadEnvFile reads .env into process.env without crashing on missing file', () => {
    loadEnvFile(makePaths(tmp));
    expect(process.env.SLACK_BOT_TOKEN).toBeUndefined();

    fs.writeFileSync(path.join(tmp, '.env'), 'SLACK_BOT_TOKEN=xoxb-abc\n');
    loadEnvFile(makePaths(tmp));
    expect(process.env.SLACK_BOT_TOKEN).toBe('xoxb-abc');
  });

  it('loadConfigJson returns empty object if file missing', () => {
    const cfg = loadConfigJson(makePaths(tmp));
    expect(cfg).toEqual({});
  });

  it('loadConfigJson parses and validates config.json', () => {
    fs.writeFileSync(
      path.join(tmp, 'config.json'),
      JSON.stringify({ defaultProviderId: 'codex-cli', repoRootDir: '/repos' }),
    );
    const cfg = loadConfigJson(makePaths(tmp));
    expect(cfg.repoRootDir).toBe('/repos');
    expect(cfg.defaultProviderId).toBe('codex-cli');
  });

  it('detectConfig reports missing required keys', () => {
    const res = detectConfig(makePaths(tmp));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.missing.sort()).toEqual(
        ['REPO_ROOT_DIR', 'SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET'].sort(),
      );
    }
  });

  it('detectConfig accepts REPO_ROOT_DIR from config.json', () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb';
    process.env.SLACK_APP_TOKEN = 'xapp';
    process.env.SLACK_SIGNING_SECRET = 'sig';
    fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ repoRootDir: '/repos' }));
    const res = detectConfig(makePaths(tmp));
    expect(res.ok).toBe(true);
  });
});
