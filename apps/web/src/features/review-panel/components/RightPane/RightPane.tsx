import type { ReviewChangedFile, ReviewFileResponse } from '../../types';
import type { DiffStyle, ViewMode } from './DiffToolbar';
import { DiffToolbar } from './DiffToolbar';
import { DiffView } from './DiffView';
import * as styles from './RightPane.styles';
import { SourceView } from './SourceView';

interface RightPaneProps {
  baseFile?: ReviewFileResponse | undefined;
  colorScheme: 'dark' | 'light';
  compactBreadcrumb?: boolean | undefined;
  contentLoading: boolean;
  diff: string;
  diffHasMore?: boolean | undefined;
  diffLoadingMore?: boolean | undefined;
  diffStyle: DiffStyle;
  file?: ReviewFileResponse | undefined;
  hideStylePill?: boolean | undefined;
  hideViewModePill?: boolean | undefined;
  onChangeDiffStyle: (next: DiffStyle) => void;
  onChangeViewMode: (next: ViewMode) => void;
  onCopyPath: () => void;
  onLoadMoreDiff?: (() => void) | undefined;
  onNext: () => void;
  onOpenDrawer?: (() => void) | undefined;
  onOpenSheet?: (() => void) | undefined;
  onPrevious: () => void;
  selectedFile?: ReviewChangedFile | undefined;
  selectedPath?: string | undefined;
  viewMode: ViewMode;
}

export function RightPane({
  baseFile,
  colorScheme,
  compactBreadcrumb,
  contentLoading,
  diff,
  diffHasMore,
  diffLoadingMore,
  diffStyle,
  file,
  hideStylePill,
  hideViewModePill,
  onChangeDiffStyle,
  onChangeViewMode,
  onCopyPath,
  onLoadMoreDiff,
  onNext,
  onOpenDrawer,
  onOpenSheet,
  onPrevious,
  selectedFile,
  selectedPath,
  viewMode,
}: RightPaneProps) {
  const hasDiff =
    diff.trim().length > 0 && (diff.includes('\n@@ ') || !/^Binary files /m.test(diff));
  const sourceAvailable =
    Boolean(selectedPath) && (file !== undefined || hasDiff || contentLoading);
  const textContent = file?.mediaType === 'text' ? file.content : undefined;
  const baseContent = baseFile?.mediaType === 'text' ? baseFile.content : undefined;
  // Diff mode requires actual diff content. Otherwise fall back to source.
  const effectiveMode: ViewMode = viewMode === 'diff' && !hasDiff ? 'source' : viewMode;
  const finalMode: ViewMode =
    effectiveMode === 'source' && !sourceAvailable ? 'diff' : effectiveMode;

  return (
    <main className={styles.root} id="review-main">
      <DiffToolbar
        compactBreadcrumb={compactBreadcrumb}
        diffStyle={diffStyle}
        hasDiff={hasDiff}
        hideStylePill={hideStylePill}
        hideViewModePill={hideViewModePill}
        selectedPath={selectedFile?.path ?? selectedPath}
        sourceAvailable={sourceAvailable}
        viewMode={finalMode}
        onChangeDiffStyle={onChangeDiffStyle}
        onChangeViewMode={onChangeViewMode}
        onCopyPath={onCopyPath}
        onNext={onNext}
        onOpenDrawer={onOpenDrawer}
        onOpenSheet={onOpenSheet}
        onPrevious={onPrevious}
      />
      <div className={styles.body}>
        {finalMode === 'source' ? (
          <SourceView
            colorScheme={colorScheme}
            diff={diff}
            file={file}
            loading={contentLoading}
            path={selectedPath}
          />
        ) : (
          <DiffView
            baseContent={baseContent}
            colorScheme={colorScheme}
            diff={diff}
            diffStyle={diffStyle}
            hasMore={diffHasMore ?? false}
            headContent={textContent}
            loadingMore={diffLoadingMore ?? false}
            selectedPath={selectedPath}
            onLoadMore={onLoadMoreDiff}
          />
        )}
      </div>
    </main>
  );
}
