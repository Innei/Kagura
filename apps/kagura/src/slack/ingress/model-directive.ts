export interface ParsedModelDirective {
  model: string;
  text: string;
}

const MODEL_NAME_PATTERN = /^[\w./:+-]+$/u;

export function extractLeadingModelDirective(text: string): ParsedModelDirective | undefined {
  const match = text.match(
    /^(\s*(?:<@[^>]+>\s*)*)(?:--model(?:=|\s+)(\S+)|model:(\S+))(?:\s+|$)/u,
  );
  if (!match) {
    return undefined;
  }

  const model = match[2] ?? match[3];
  if (!model || !MODEL_NAME_PATTERN.test(model)) {
    return undefined;
  }

  const prefix = match[1] ?? '';
  const nextText = `${prefix}${text.slice(match[0].length)}`.trim();
  return { model, text: nextText };
}
