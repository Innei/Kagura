import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { piAgentProvider } from '../src/providers/pi-agent.js';
import type { PromptCtx, PromptOption } from '../src/providers/types.js';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFileSync: vi.fn() };
});

const mockExec = execFileSync as unknown as ReturnType<typeof vi.fn>;

function ctx(answers: Record<string, string | undefined>): PromptCtx {
  return {
    select: async <T extends string>(_m: string, options: PromptOption<T>[]): Promise<T> => {
      return (answers.select as T | undefined) ?? (options[0]?.value as T);
    },
    text: async (message: string) => answers[`text:${message}`],
    password: async (message: string) => answers[`pw:${message}`],
    note: () => {
      /* noop */
    },
  };
}

afterEach(() => {
  mockExec.mockReset();
});

describe('piAgentProvider', () => {
  it('detects pi CLI on PATH as ready', async () => {
    mockExec.mockReturnValue('pi 1.2.3');
    const res = await piAgentProvider.detect();
    expect(res.status).toBe('ready');
  });

  it('detects absent when pi is not on PATH', async () => {
    mockExec.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const res = await piAgentProvider.detect();
    expect(res.status).toBe('absent');
  });

  it('writes pi-agent config with default prompt mode', async () => {
    const patch = await piAgentProvider.prompt(ctx({}));
    expect(patch.config).toEqual({
      defaultProviderId: 'pi-agent',
      piAgent: {
        args: ['-p', '--mode', 'json'],
        command: 'pi',
      },
    });
  });

  it('accepts custom command and args', async () => {
    const patch = await piAgentProvider.prompt(
      ctx({
        'text:Pi Agent command': '/opt/bin/pi',
        'text:Pi Agent prompt args': '-p --fast',
      }),
    );
    expect(patch.config?.piAgent).toEqual({
      args: ['-p', '--fast'],
      command: '/opt/bin/pi',
    });
  });
});
