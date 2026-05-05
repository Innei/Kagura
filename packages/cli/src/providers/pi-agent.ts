import { execFileSync } from 'node:child_process';

import type { ProviderSetup } from './types.js';

export const piAgentProvider: ProviderSetup = {
  id: 'pi-agent',
  label: 'Pi Agent CLI',
  order: 30,

  async detect() {
    const command = process.env.PI_AGENT_COMMAND?.trim() || 'pi';
    try {
      const out = execFileSync(command, ['--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return { status: 'ready', detail: out.trim() || `${command} detected` };
    } catch {
      return { status: 'absent', detail: `\`${command}\` not on PATH` };
    }
  },

  async prompt(ctx) {
    const command = await ctx.text('Pi Agent command', {
      initial: 'pi',
      optional: true,
      placeholder: 'pi',
    });
    const args = await ctx.text('Pi Agent prompt args', {
      initial: '-p --mode json',
      optional: true,
      placeholder: '-p --mode json',
    });

    return {
      config: {
        defaultProviderId: 'pi-agent',
        piAgent: {
          args: splitArgs(args ?? '-p --mode json'),
          command: command ?? 'pi',
        },
      },
    };
  },
};

function splitArgs(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}
