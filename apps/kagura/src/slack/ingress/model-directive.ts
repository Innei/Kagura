import type { SessionReasoningEffort } from '~/session/types.js';

export interface ParsedSessionDirectives {
  model?: string | undefined;
  reasoningEffort?: SessionReasoningEffort | undefined;
  text: string;
}

const MODEL_NAME_PATTERN = /^[\w./:+-]+$/u;
const REASONING_EFFORTS = new Set<SessionReasoningEffort>(['low', 'medium', 'high', 'xhigh']);

function isReasoningEffort(value: string): value is SessionReasoningEffort {
  return REASONING_EFFORTS.has(value as SessionReasoningEffort);
}

function parseNextDirective(
  text: string,
):
  | { kind: 'model'; value: string; consumedLength: number }
  | { kind: 'reasoningEffort'; value: SessionReasoningEffort; consumedLength: number }
  | undefined {
  const match = text.match(/^(?:--(model|effort)(?:=|\s+)(\S+)|(model|effort):(\S+))(?:\s+|$)/u);
  if (!match) {
    return undefined;
  }

  const key = match[1] ?? match[3];
  const value = match[2] ?? match[4];
  if (!key || !value) {
    return undefined;
  }

  if (key === 'model') {
    if (!MODEL_NAME_PATTERN.test(value)) {
      return undefined;
    }
    return { kind: 'model', value, consumedLength: match[0].length };
  }

  if (!isReasoningEffort(value)) {
    return undefined;
  }
  return { kind: 'reasoningEffort', value, consumedLength: match[0].length };
}

export function extractLeadingSessionDirectives(text: string): ParsedSessionDirectives | undefined {
  const prefixMatch = text.match(/^(\s*(?:<@[^>]+>\s*)*)/u);
  const prefix = prefixMatch?.[1] ?? '';
  let rest = text.slice(prefix.length);
  let model: string | undefined;
  let reasoningEffort: SessionReasoningEffort | undefined;
  let consumed = false;

  for (;;) {
    const directive = parseNextDirective(rest);
    if (!directive) break;

    consumed = true;
    if (directive.kind === 'model') {
      model = directive.value;
    } else {
      reasoningEffort = directive.value;
    }
    rest = rest.slice(directive.consumedLength);
  }

  if (!consumed) {
    return undefined;
  }

  return {
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    text: `${prefix}${rest}`.trim(),
  };
}
