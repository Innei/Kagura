import type { ChatMessage } from '~/memory/reconciler/llm-client.js';

export interface ThreadTitleLlm {
  chat: (messages: ChatMessage[]) => Promise<string>;
}

export interface ThreadTitleGenerator {
  generate: (input: ThreadTitleInput) => Promise<string | undefined>;
}

export interface ThreadTitleInput {
  files?: Array<{ name?: string | null | undefined }> | undefined;
  text: string;
}

const MAX_FALLBACK_TITLE_LENGTH = 120;
const MAX_INPUT_TEXT_LENGTH = 2_000;
const MAX_TITLE_LENGTH = 80;

const SYSTEM_PROMPT = `Generate a concise Slack thread title for an agent session.

Return strictly JSON: {"title":"..."}.

Rules:
- Use the user's language when possible.
- Keep it under 8 words and 80 characters.
- Prefer an action/object phrase over a sentence.
- Do not include quotes, usernames, bot mentions, channel names, or markdown.
- If the request is empty or only a bot mention, return {"title":""}.`;

export class LlmThreadTitleGenerator implements ThreadTitleGenerator {
  constructor(private readonly llm: ThreadTitleLlm) {}

  async generate(input: ThreadTitleInput): Promise<string | undefined> {
    const raw = await this.llm.chat([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(toPayload(input), null, 2) },
    ]);
    const title = parseGeneratedTitle(raw);
    return title ? title : undefined;
  }
}

export function fallbackThreadTitle(input: ThreadTitleInput): string | undefined {
  const withoutBotMentions = input.text.replaceAll(/<@[^>]+>/gu, ' ');
  const collapsed = withoutBotMentions.replaceAll(/\s+/gu, ' ').trim();
  if (collapsed) {
    return truncateTitle(collapsed, MAX_FALLBACK_TITLE_LENGTH);
  }

  const fileName = input.files?.find((file) => file.name?.trim())?.name?.trim();
  if (fileName) {
    return truncateTitle(`File: ${fileName}`, MAX_FALLBACK_TITLE_LENGTH);
  }

  return undefined;
}

function toPayload(input: ThreadTitleInput): unknown {
  return {
    text: input.text.slice(0, MAX_INPUT_TEXT_LENGTH),
    files:
      input.files
        ?.map((file) => file.name?.trim())
        .filter((name): name is string => Boolean(name))
        .slice(0, 10) ?? [],
  };
}

function parseGeneratedTitle(raw: string): string {
  const parsed = JSON.parse(raw) as { title?: unknown };
  if (typeof parsed.title !== 'string') {
    return '';
  }
  return sanitizeTitle(parsed.title);
}

function sanitizeTitle(title: string): string {
  const withoutMarkup = title
    .replaceAll(/<@[^>]+>/gu, ' ')
    .replaceAll(/[#*_`~>|]+/gu, ' ')
    .replaceAll(/["'“”‘’]/gu, '');
  return truncateTitle(withoutMarkup.replaceAll(/\s+/gu, ' ').trim(), MAX_TITLE_LENGTH);
}

function truncateTitle(title: string, maxLength: number): string {
  if (title.length <= maxLength) {
    return title;
  }

  const sliced = title.slice(0, maxLength).trimEnd();
  const lastSpace = sliced.lastIndexOf(' ');
  if (lastSpace >= Math.floor(maxLength * 0.6)) {
    return sliced.slice(0, lastSpace);
  }
  return sliced;
}
