import fs from 'node:fs';

import dotenv from 'dotenv';

import type { KaguraPaths } from './paths.js';

export interface AppConfigJson {
  claude?: {
    model?: string;
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
    enableSkills?: boolean;
  };
  codex?: {
    model?: string;
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  };
  defaultProviderId?: 'claude-code' | 'codex-cli' | 'pi-agent';
  logDir?: string;
  logLevel?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  logToFile?: boolean;
  piAgent?: {
    args?: string[];
    command?: string;
    model?: string;
  };
  repoRootDir?: string;
  repoScanDepth?: number;
  sessionDbPath?: string;
}

const REQUIRED = [
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'SLACK_SIGNING_SECRET',
  'REPO_ROOT_DIR',
] as const;

export function loadEnvFile(paths: KaguraPaths): void {
  if (!fs.existsSync(paths.envFile)) return;
  dotenv.config({ path: paths.envFile, override: false });
}

export function loadConfigJson(paths: KaguraPaths): AppConfigJson {
  if (!fs.existsSync(paths.configJsonFile)) return {};
  try {
    const raw = fs.readFileSync(paths.configJsonFile, 'utf8');
    return JSON.parse(raw) as AppConfigJson;
  } catch {
    return {};
  }
}

export type DetectResult =
  | { ok: true }
  | { ok: false; missing: string[]; envFile: string; configJsonFile: string };

export function detectConfig(paths: KaguraPaths): DetectResult {
  loadEnvFile(paths);
  const cfg = loadConfigJson(paths);

  const missing: string[] = [];
  for (const key of REQUIRED) {
    const envVal = process.env[key]?.trim();
    if (envVal) continue;
    if (key === 'REPO_ROOT_DIR' && cfg.repoRootDir?.trim()) continue;
    missing.push(key);
  }

  if (missing.length === 0) return { ok: true };
  return { ok: false, missing, envFile: paths.envFile, configJsonFile: paths.configJsonFile };
}
