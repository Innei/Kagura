import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveKaguraPaths } from '@kagura/cli/config/paths';
import { createEnv } from '@t3-oss/env-core';
import dotenv from 'dotenv';
import { z } from 'zod';

const kaguraPaths = resolveKaguraPaths();
if (fs.existsSync(kaguraPaths.envFile)) {
  dotenv.config({ path: kaguraPaths.envFile, override: false });
}
dotenv.config({ override: false }); // dev mode: also read cwd .env if present

const booleanStringSchema = z.enum(['true', 'false']).transform((value) => value === 'true');
const optionalPositiveInteger = z.coerce.number().int().positive().optional();

const agentTeamMemberConfigSchema = z.union([
  z.string().min(1),
  z
    .object({
      id: z.string().min(1),
      label: z.string().min(1).optional(),
      role: z.string().min(1).optional(),
    })
    .strict(),
]);

const agentTeamConfigSchema = z
  .object({
    defaultLead: z.string().min(1).optional(),
    members: z.array(agentTeamMemberConfigSchema).optional(),
    name: z.string().min(1).optional(),
  })
  .strict();

const appConfigSchema = z
  .object({
    a2a: z
      .object({
        diagnosticsDir: z.string().optional(),
        outputMode: z.enum(['verbose', 'quiet']).optional(),
      })
      .strict()
      .optional(),
    agentTeams: z.record(z.string().min(1), agentTeamConfigSchema).optional(),
    claude: z
      .object({
        enableSkills: z.boolean().optional(),
        model: z.string().optional(),
        permissionMode: z
          .enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'])
          .optional(),
      })
      .optional(),
    codex: z
      .object({
        model: z.string().optional(),
        reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
        sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
      })
      .optional(),
    piAgent: z
      .object({
        args: z.array(z.string()).optional(),
        command: z.string().optional(),
        model: z.string().optional(),
      })
      .strict()
      .optional(),
    defaultProviderId: z.enum(['claude-code', 'codex-cli', 'pi-agent']).optional(),
    logDir: z.string().optional(),
    logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),
    logToFile: z.boolean().optional(),
    memory: z
      .object({
        reconciler: z
          .object({
            enabled: z.boolean().optional(),
            baseUrl: z.string().url().optional(),
            model: z.string().min(1).optional(),
            intervalMs: z.number().int().positive().optional(),
            writeThreshold: z.number().int().nonnegative().optional(),
            batchSize: z.number().int().positive().optional(),
            timeoutMs: z.number().int().positive().optional(),
            maxTokens: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    repoRootDir: z.string().optional(),
    repoScanDepth: z.number().int().min(0).optional(),
    worktreeRootDir: z.string().optional(),
    reviewPanel: z
      .object({
        assetsDir: z.string().optional(),
        baseUrl: z.string().url().optional(),
        enabled: z.boolean().optional(),
        host: z.string().optional(),
        port: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    sessionDbPath: z.string().optional(),
    a2aCoordinatorDbPath: z.string().optional(),
    slackConfigTokenStorePath: z.string().optional(),
  })
  .strict();

type AppConfig = z.infer<typeof appConfigSchema>;
export type AppConfigAgentTeams = NonNullable<AppConfig['agentTeams']>;

function loadAppConfig(): AppConfig {
  const override = process.env.APP_CONFIG_PATH?.trim();
  const resolved = override ? path.resolve(process.cwd(), override) : kaguraPaths.configJsonFile;
  if (!fs.existsSync(resolved)) {
    return {};
  }

  const raw = fs.readFileSync(resolved, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  return appConfigSchema.parse(parsed);
}

const appConfig = loadAppConfig();
export const appConfigAgentTeams: AppConfigAgentTeams = appConfig.agentTeams ?? {};

function configString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function configBoolean(value: boolean | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function configNumber(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function configStringArray(value: string[] | undefined): string | undefined {
  return value === undefined ? undefined : JSON.stringify(value);
}

function envOrConfig(envName: string, configValue: string | undefined): string | undefined {
  const raw = process.env[envName];
  if (raw === undefined) {
    return configValue;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? raw : configValue;
}

function resolveDefaultRepoRootDir(): string | undefined {
  return envOrConfig('REPO_ROOT_DIR', configString(appConfig.repoRootDir));
}

function resolveDefaultWorktreeRootDir(): string {
  const repoRootDir = resolveDefaultRepoRootDir();
  if (repoRootDir) {
    return path.join(repoRootDir, 'kagura-worktrees');
  }

  return path.join(kaguraPaths.configDir, 'kagura-worktrees');
}

function resolveDefaultReviewPanelAssetsDir(): string {
  const distDir = path.dirname(fileURLToPath(import.meta.url));
  const bundledAssetsDir = path.join(distDir, 'review-panel');
  if (fs.existsSync(bundledAssetsDir)) {
    return bundledAssetsDir;
  }

  return './apps/web/dist';
}

export const env = createEnv({
  server: {
    APP_CONFIG_PATH: z.string().min(1).optional(),
    AGENT_DEFAULT_PROVIDER: z.enum(['claude-code', 'codex-cli', 'pi-agent']).default('claude-code'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    SLACK_BOT_TOKEN: z.string().min(1),
    SLACK_BOT_2_TOKEN: z.string().min(1).optional(),
    SLACK_APP_TOKEN: z.string().min(1),
    SLACK_APP_2_TOKEN: z.string().min(1).optional(),
    SLACK_APP_ID: z.string().min(1).optional(),
    SLACK_CONFIG_TOKEN: z.string().min(1).optional(),
    SLACK_CONFIG_REFRESH_TOKEN: z.string().min(1).optional(),
    SLACK_CONFIG_TOKEN_STORE_PATH: z.string().min(1).default('./data/slack-config-tokens.json'),
    SLACK_SIGNING_SECRET: z.string().min(1),
    SLACK_SIGNING_2_SECRET: z.string().min(1).optional(),
    SLACK_REACTION_NAME: z.string().min(1).default('eyes'),
    SLACK_REACTION_DONE_NAME: z.string().min(1).default('white_check_mark'),
    CLAUDE_MODEL: z.string().min(1).optional(),
    CLAUDE_PERMISSION_MODE: z
      .enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'])
      .default('bypassPermissions'),
    CLAUDE_ENABLE_SKILLS: booleanStringSchema.default(false),
    CODEX_MODEL: z.string().min(1).optional(),
    CODEX_REASONING_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
    CODEX_CLI_SANDBOX: z
      .enum(['read-only', 'workspace-write', 'danger-full-access'])
      .default('danger-full-access'),
    PI_AGENT_COMMAND: z.string().min(1).default('pi'),
    PI_AGENT_ARGS: z.string().min(1).default('["-p","--mode","json"]'),
    PI_AGENT_MODEL: z.string().min(1).optional(),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    LOG_TO_FILE: booleanStringSchema.default(false),
    LOG_DIR: z.string().min(1).default('./logs'),
    REPO_ROOT_DIR: z.string().min(1),
    REPO_SCAN_DEPTH: z.coerce.number().int().min(0).default(2),
    WORKTREE_ROOT_DIR: z.string().min(1).default(resolveDefaultWorktreeRootDir()),
    KAGURA_MEMORY_RECONCILER_ENABLED: booleanStringSchema.default(false),
    KAGURA_MEMORY_RECONCILER_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
    KAGURA_MEMORY_RECONCILER_API_KEY: z.string().min(1).optional(),
    KAGURA_MEMORY_RECONCILER_MODEL: z.string().min(1).default('gpt-4o-mini'),
    KAGURA_MEMORY_RECONCILER_INTERVAL_MS: z.coerce.number().int().positive().default(21_600_000),
    KAGURA_MEMORY_RECONCILER_WRITE_THRESHOLD: z.coerce.number().int().nonnegative().default(5),
    KAGURA_MEMORY_RECONCILER_BATCH_SIZE: z.coerce.number().int().positive().default(50),
    KAGURA_MEMORY_RECONCILER_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    KAGURA_MEMORY_RECONCILER_MAX_TOKENS: z.coerce.number().int().positive().default(1024),
    KAGURA_REVIEW_PANEL_ENABLED: booleanStringSchema.default(false),
    KAGURA_REVIEW_PANEL_HOST: z.string().min(1).default('127.0.0.1'),
    KAGURA_REVIEW_PANEL_PORT: z.coerce.number().int().positive().default(3077),
    KAGURA_REVIEW_PANEL_BASE_URL: z.string().url().default('http://127.0.0.1:3077'),
    KAGURA_REVIEW_PANEL_ASSETS_DIR: z.string().min(1).default(resolveDefaultReviewPanelAssetsDir()),
    SESSION_DB_PATH: z.string().min(1).default('./data/sessions.db'),
    A2A_COORDINATOR_DB_PATH: z.string().min(1).default('./data/a2a-coordinator.db'),
    A2A_OUTPUT_MODE: z.enum(['verbose', 'quiet']).default('verbose'),
    A2A_DIAGNOSTICS_DIR: z.string().min(1).default('./data/a2a-diagnostics'),
    SLACK_E2E_ENABLED: booleanStringSchema.default(false),
    SLACK_E2E_CHANNEL_ID: z.string().min(1).optional(),
    SLACK_E2E_RESULT_PATH: z.string().min(1).default('./artifacts/slack-live-e2e/result.json'),
    SLACK_E2E_STATUS_PROBE_PATH: z
      .string()
      .min(1)
      .default('./artifacts/slack-live-e2e/status-probe.jsonl'),
    SLACK_E2E_EXECUTION_PROBE_PATH: z
      .string()
      .min(1)
      .default('./artifacts/slack-live-e2e/execution-probe.jsonl'),
    SLACK_E2E_TIMEOUT_MS: optionalPositiveInteger.default(180_000),
    SLACK_E2E_TRIGGER_USER_TOKEN: z.string().min(1).optional(),
  },
  runtimeEnvStrict: {
    APP_CONFIG_PATH: process.env.APP_CONFIG_PATH,
    AGENT_DEFAULT_PROVIDER: envOrConfig('AGENT_DEFAULT_PROVIDER', appConfig.defaultProviderId),
    NODE_ENV: process.env.NODE_ENV,
    PORT: process.env.PORT,
    SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
    SLACK_BOT_2_TOKEN: process.env.SLACK_BOT_2_TOKEN,
    SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN,
    SLACK_APP_2_TOKEN: process.env.SLACK_APP_2_TOKEN,
    SLACK_APP_ID: process.env.SLACK_APP_ID,
    SLACK_CONFIG_TOKEN: process.env.SLACK_CONFIG_TOKEN,
    SLACK_CONFIG_REFRESH_TOKEN: process.env.SLACK_CONFIG_REFRESH_TOKEN,
    SLACK_CONFIG_TOKEN_STORE_PATH: envOrConfig(
      'SLACK_CONFIG_TOKEN_STORE_PATH',
      configString(appConfig.slackConfigTokenStorePath),
    ),
    SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,
    SLACK_SIGNING_2_SECRET: process.env.SLACK_SIGNING_2_SECRET,
    SLACK_REACTION_NAME: process.env.SLACK_REACTION_NAME,
    SLACK_REACTION_DONE_NAME: process.env.SLACK_REACTION_DONE_NAME,
    CLAUDE_MODEL: envOrConfig('CLAUDE_MODEL', configString(appConfig.claude?.model)),
    CLAUDE_PERMISSION_MODE: envOrConfig('CLAUDE_PERMISSION_MODE', appConfig.claude?.permissionMode),
    CLAUDE_ENABLE_SKILLS: envOrConfig(
      'CLAUDE_ENABLE_SKILLS',
      configBoolean(appConfig.claude?.enableSkills),
    ),
    CODEX_MODEL: envOrConfig('CODEX_MODEL', configString(appConfig.codex?.model)),
    CODEX_REASONING_EFFORT: envOrConfig('CODEX_REASONING_EFFORT', appConfig.codex?.reasoningEffort),
    CODEX_CLI_SANDBOX: envOrConfig('CODEX_CLI_SANDBOX', appConfig.codex?.sandbox),
    PI_AGENT_COMMAND: envOrConfig('PI_AGENT_COMMAND', configString(appConfig.piAgent?.command)),
    PI_AGENT_ARGS: envOrConfig('PI_AGENT_ARGS', configStringArray(appConfig.piAgent?.args)),
    PI_AGENT_MODEL: envOrConfig('PI_AGENT_MODEL', configString(appConfig.piAgent?.model)),
    LOG_LEVEL: envOrConfig('LOG_LEVEL', appConfig.logLevel),
    LOG_TO_FILE: envOrConfig('LOG_TO_FILE', configBoolean(appConfig.logToFile)),
    LOG_DIR: envOrConfig('LOG_DIR', configString(appConfig.logDir)),
    REPO_ROOT_DIR: envOrConfig('REPO_ROOT_DIR', configString(appConfig.repoRootDir)),
    REPO_SCAN_DEPTH: envOrConfig('REPO_SCAN_DEPTH', configNumber(appConfig.repoScanDepth)),
    WORKTREE_ROOT_DIR: envOrConfig('WORKTREE_ROOT_DIR', configString(appConfig.worktreeRootDir)),
    KAGURA_MEMORY_RECONCILER_ENABLED: envOrConfig(
      'KAGURA_MEMORY_RECONCILER_ENABLED',
      configBoolean(appConfig.memory?.reconciler?.enabled),
    ),
    KAGURA_MEMORY_RECONCILER_BASE_URL: envOrConfig(
      'KAGURA_MEMORY_RECONCILER_BASE_URL',
      configString(appConfig.memory?.reconciler?.baseUrl),
    ),
    KAGURA_MEMORY_RECONCILER_API_KEY: process.env.KAGURA_MEMORY_RECONCILER_API_KEY,
    KAGURA_MEMORY_RECONCILER_MODEL: envOrConfig(
      'KAGURA_MEMORY_RECONCILER_MODEL',
      configString(appConfig.memory?.reconciler?.model),
    ),
    KAGURA_MEMORY_RECONCILER_INTERVAL_MS: envOrConfig(
      'KAGURA_MEMORY_RECONCILER_INTERVAL_MS',
      configNumber(appConfig.memory?.reconciler?.intervalMs),
    ),
    KAGURA_MEMORY_RECONCILER_WRITE_THRESHOLD: envOrConfig(
      'KAGURA_MEMORY_RECONCILER_WRITE_THRESHOLD',
      configNumber(appConfig.memory?.reconciler?.writeThreshold),
    ),
    KAGURA_MEMORY_RECONCILER_BATCH_SIZE: envOrConfig(
      'KAGURA_MEMORY_RECONCILER_BATCH_SIZE',
      configNumber(appConfig.memory?.reconciler?.batchSize),
    ),
    KAGURA_MEMORY_RECONCILER_TIMEOUT_MS: envOrConfig(
      'KAGURA_MEMORY_RECONCILER_TIMEOUT_MS',
      configNumber(appConfig.memory?.reconciler?.timeoutMs),
    ),
    KAGURA_MEMORY_RECONCILER_MAX_TOKENS: envOrConfig(
      'KAGURA_MEMORY_RECONCILER_MAX_TOKENS',
      configNumber(appConfig.memory?.reconciler?.maxTokens),
    ),
    KAGURA_REVIEW_PANEL_ENABLED: envOrConfig(
      'KAGURA_REVIEW_PANEL_ENABLED',
      configBoolean(appConfig.reviewPanel?.enabled),
    ),
    KAGURA_REVIEW_PANEL_HOST: envOrConfig(
      'KAGURA_REVIEW_PANEL_HOST',
      configString(appConfig.reviewPanel?.host),
    ),
    KAGURA_REVIEW_PANEL_PORT: envOrConfig(
      'KAGURA_REVIEW_PANEL_PORT',
      configNumber(appConfig.reviewPanel?.port),
    ),
    KAGURA_REVIEW_PANEL_BASE_URL: envOrConfig(
      'KAGURA_REVIEW_PANEL_BASE_URL',
      configString(appConfig.reviewPanel?.baseUrl),
    ),
    KAGURA_REVIEW_PANEL_ASSETS_DIR: envOrConfig(
      'KAGURA_REVIEW_PANEL_ASSETS_DIR',
      configString(appConfig.reviewPanel?.assetsDir),
    ),
    SESSION_DB_PATH: envOrConfig('SESSION_DB_PATH', configString(appConfig.sessionDbPath)),
    A2A_COORDINATOR_DB_PATH: envOrConfig(
      'A2A_COORDINATOR_DB_PATH',
      configString(appConfig.a2aCoordinatorDbPath),
    ),
    A2A_OUTPUT_MODE: envOrConfig('A2A_OUTPUT_MODE', appConfig.a2a?.outputMode),
    A2A_DIAGNOSTICS_DIR: envOrConfig(
      'A2A_DIAGNOSTICS_DIR',
      configString(appConfig.a2a?.diagnosticsDir),
    ),
    SLACK_E2E_ENABLED: process.env.SLACK_E2E_ENABLED,
    SLACK_E2E_CHANNEL_ID: process.env.SLACK_E2E_CHANNEL_ID,
    SLACK_E2E_RESULT_PATH: process.env.SLACK_E2E_RESULT_PATH,
    SLACK_E2E_STATUS_PROBE_PATH: process.env.SLACK_E2E_STATUS_PROBE_PATH,
    SLACK_E2E_EXECUTION_PROBE_PATH: process.env.SLACK_E2E_EXECUTION_PROBE_PATH,
    SLACK_E2E_TIMEOUT_MS: process.env.SLACK_E2E_TIMEOUT_MS,
    SLACK_E2E_TRIGGER_USER_TOKEN: process.env.SLACK_E2E_TRIGGER_USER_TOKEN,
  },
  emptyStringAsUndefined: true,
});

export type AppEnv = typeof env;

export function validateLiveE2EEnv(): void {
  if (!env.SLACK_E2E_ENABLED) {
    return;
  }

  const missing: string[] = [];
  if (!env.SLACK_E2E_CHANNEL_ID) missing.push('SLACK_E2E_CHANNEL_ID');
  if (!env.SLACK_E2E_TRIGGER_USER_TOKEN) missing.push('SLACK_E2E_TRIGGER_USER_TOKEN');

  if (missing.length > 0) {
    throw new Error(`Missing live E2E environment variables: ${missing.join(', ')}`);
  }
}
