import type { EnvPatch } from '../config/env-writer.js';
import type { ConfigPatch } from '../config/json-writer.js';

export type ProviderId = 'claude-code' | 'codex-cli' | 'pi-agent';

export interface DetectResult {
  detail?: string;
  status: 'ready' | 'partial' | 'absent';
}

export interface ValidateResult {
  detail?: string;
  status: 'ok' | 'warn' | 'fail';
}

export interface SetupPatch {
  config?: ConfigPatch;
  env?: EnvPatch;
}

export interface PromptOption<T extends string> {
  label: string;
  value: T;
}

export interface PromptCtx {
  note: (message: string) => void;
  password: (message: string, opts?: { optional?: boolean }) => Promise<string | undefined>;
  select: <T extends string>(message: string, options: PromptOption<T>[]) => Promise<T>;
  text: (
    message: string,
    opts?: { placeholder?: string; initial?: string; optional?: boolean },
  ) => Promise<string | undefined>;
}

export interface ProviderSetup {
  detect: () => Promise<DetectResult>;
  id: ProviderId;
  label: string;
  order: number;
  prompt: (ctx: PromptCtx) => Promise<SetupPatch>;
  validate?: (env: NodeJS.ProcessEnv) => Promise<ValidateResult>;
}
