import type { ReactElement } from 'react';
import { useMemo } from 'react';

import type { ReviewFileResponse } from '../../types';
import * as styles from './SourceView.styles';
import { extractShikiLines, useShikiHtml } from './use-shiki-html';

interface SourceViewProps {
  colorScheme: 'dark' | 'light';
  diff: string;
  file?: ReviewFileResponse | undefined;
  loading: boolean;
  path?: string | undefined;
}

const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const PLACEHOLDER_LINE = '  // …';

function computeAddedLines(diff: string): Set<number> {
  const added = new Set<number>();
  if (!diff.trim()) return added;
  const lines = diff.split('\n');
  let cursor = 0;
  for (const line of lines) {
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('Binary files')
    ) {
      continue;
    }
    const match = HUNK_HEADER_RE.exec(line);
    if (match) {
      cursor = Number.parseInt(match[1] ?? '0', 10);
      if (!Number.isFinite(cursor)) cursor = 0;
      continue;
    }
    if (cursor === 0) continue;
    if (line.startsWith('+')) {
      added.add(cursor);
      cursor += 1;
    } else if (line.startsWith('-')) {
      // skip
    } else if (line.startsWith('\\')) {
      // skip
    } else {
      cursor += 1;
    }
  }
  return added;
}

export function SourceView({ colorScheme, diff, file, loading, path }: SourceViewProps) {
  const content = file?.mediaType === 'text' ? file.content : undefined;
  const added = useMemo(() => computeAddedLines(diff), [diff]);
  const html = useShikiHtml(content, path, colorScheme);
  const highlightedLines = useMemo(() => (html ? extractShikiLines(html) : undefined), [html]);

  if (!path) {
    return <div className={styles.empty}>Select a file to view source.</div>;
  }
  if (loading && content === undefined) {
    return <div className={styles.empty}>Loading…</div>;
  }
  if (file?.mediaType === 'image' && file.content && file.mimeType) {
    return (
      <div className={styles.mediaRoot}>
        <img
          alt={path ?? 'Review image'}
          className={styles.imagePreview}
          src={`data:${file.mimeType};base64,${file.content}`}
        />
      </div>
    );
  }
  if (file?.mediaType === 'binary') {
    return <div className={styles.empty}>Binary file preview is not available.</div>;
  }
  if (content === undefined) {
    return <div className={styles.empty}>Source view is not available for this file.</div>;
  }

  const rawLines = content.split('\n');
  const useHighlight = highlightedLines && highlightedLines.length === rawLines.length;
  const rows: ReactElement[] = [];
  let skipStart: number | null = null;

  const flushSkip = (endLine: number) => {
    if (skipStart === null) return;
    const count = endLine - skipStart + 1;
    rows.push(
      <div className={styles.skipRow} key={`skip:${skipStart}`}>
        {count} {count === 1 ? 'line' : 'lines'} hidden
      </div>,
    );
    skipStart = null;
  };

  rawLines.forEach((line, index) => {
    const lineNumber = index + 1;
    const isAdded = added.has(lineNumber);
    if (line === PLACEHOLDER_LINE && !isAdded) {
      if (skipStart === null) skipStart = lineNumber;
      return;
    }
    if (skipStart !== null) flushSkip(lineNumber - 1);
    const gutterClass = isAdded ? `${styles.gutter} ${styles.gutterAdded}` : styles.gutter;
    const codeClass = isAdded ? `${styles.codeLine} ${styles.codeAdded}` : styles.codeLine;
    const inner = useHighlight ? highlightedLines[index] : escapeHtml(line || ' ');
    rows.push(
      <div className={styles.row} key={lineNumber}>
        <span className={styles.ln}>{lineNumber}</span>
        <span className={gutterClass} />
        <span className={codeClass} dangerouslySetInnerHTML={{ __html: inner || '&nbsp;' }} />
      </div>,
    );
  });
  if (skipStart !== null) flushSkip(rawLines.length);

  return (
    <div className={`${styles.root} ${useHighlight ? styles.shiki : ''}`}>
      <div className={styles.list}>{rows}</div>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
