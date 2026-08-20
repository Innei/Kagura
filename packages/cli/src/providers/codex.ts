import { execFileSync } from 'node:child_process';

import type { ProviderSetup } from './types.js';

export const codexProvider: ProviderSetup = {
  id: 'codex-cli',
  label: 'Codex CLI (OpenAI)',
  order: 20,

  async detect() {
    try {
      const out = execFileSync('codex', ['--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      return { status: 'ready', detail: out.trim() };
    } catch {
      return { status: 'absent', detail: '`codex` not on PATH' };
    }
  },

  async prompt(ctx) {
    const mode = await ctx.select('Codex authentication', [
      { value: 'chatgpt-login', label: 'ChatGPT login (already ran `codex login`)' },
      { value: 'api-key', label: 'Supply OPENAI_API_KEY' },
    ]);

    const config = { defaultProviderId: 'codex-cli' as const };

    if (mode === 'chatgpt-login') return { env: {}, config };
    const key = await ctx.password('OPENAI_API_KEY');
    return { env: { OPENAI_API_KEY: key }, config };
  },
};
