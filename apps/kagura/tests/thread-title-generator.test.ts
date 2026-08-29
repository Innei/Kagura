import { describe, expect, it, vi } from 'vitest';

import {
  fallbackThreadTitle,
  LlmThreadTitleGenerator,
} from '~/slack/ingress/thread-title-generator.js';

describe('thread title generator', () => {
  it('parses and sanitizes JSON titles from the LLM', async () => {
    const llm = { chat: vi.fn().mockResolvedValue('{"title":"“修复 *Slack* 标题”"}') };
    const generator = new LlmThreadTitleGenerator(llm);

    await expect(generator.generate({ text: '<@U_BOT> 现在接一下 thread title' })).resolves.toBe(
      '修复 Slack 标题',
    );
  });

  it('uses cleaned user text as fallback', () => {
    expect(fallbackThreadTitle({ text: '<@U_BOT> 现在接一下 thread title' })).toBe(
      '现在接一下 thread title',
    );
  });

  it('uses attached file names when text only contains a bot mention', () => {
    expect(
      fallbackThreadTitle({
        text: '<@U_BOT>',
        files: [{ name: 'trace.log' }],
      }),
    ).toBe('File: trace.log');
  });
});
