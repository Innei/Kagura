import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ImperativePanelHandle } from 'react-resizable-panels';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';

import { useBreakpoint } from '../../../theme/use-breakpoint';
import { useColorScheme } from '../../../theme/use-color-scheme';
import { useFileNav } from '../hooks/use-file-nav';
import { useKeyboardShortcuts } from '../hooks/use-keyboard-shortcuts';
import type {
  ReviewChangedFile,
  ReviewFileResponse,
  ReviewSession,
  ReviewTreeEntry,
} from '../types';
import { compareTreePaths } from '../utils/compare-paths';
import { BottomSheetFiles } from './BottomSheetFiles';
import { DrawerSidebar } from './DrawerSidebar';
import * as styles from './ReviewLayout.styles';
import type { DiffStyle, ViewMode } from './RightPane/DiffToolbar';
import { RightPane } from './RightPane/RightPane';
import { Sidebar } from './Sidebar/Sidebar';
import type { SidebarTab } from './Sidebar/SidebarTabs';
import type { FileNavView } from './Sidebar/SidebarToolbar';
import { StatusBar } from './StatusBar';
import { TitleBar } from './TitleBar';

interface ReviewLayoutProps {
  baseFile?: ReviewFileResponse | undefined;
  contentLoading?: boolean;
  diff: string;
  file?: ReviewFileResponse | undefined;
  initialViewMode?: ViewMode | undefined;
  onRequestTree?: () => void;
  onSelectPath: (path: string | undefined) => void;
  selectedPath?: string | undefined;
  session: ReviewSession;
  treeEntries?: ReviewTreeEntry[] | undefined;
  treeLoading?: boolean;
}

export function ReviewLayout({
  baseFile,
  contentLoading,
  diff,
  file,
  initialViewMode,
  onRequestTree,
  onSelectPath,
  selectedPath,
  session,
  treeEntries,
  treeLoading,
}: ReviewLayoutProps) {
  const colorScheme = useColorScheme();
  const breakpoint = useBreakpoint();
  const isDesktop = breakpoint === 'desktop';
  const isTablet = breakpoint === 'tablet';
  const isMobile = breakpoint === 'mobile';
  const sidebarRef = useRef<ImperativePanelHandle>(null);
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [tab, setTab] = useState<SidebarTab>('changes');
  const [view, setView] = useState<FileNavView>('tree');
  const [filter, setFilter] = useState('');
  const [diffStyle, setDiffStyle] = useState<DiffStyle>('split');
  const [viewMode, setViewMode] = useState<ViewMode>(initialViewMode ?? 'diff');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  const orderedChangedFiles = useMemo(() => {
    const arr = [...session.changedFiles];
    arr.sort((a, b) =>
      view === 'flat' ? a.path.localeCompare(b.path) : compareTreePaths(a.path, b.path),
    );
    return arr;
  }, [session.changedFiles, view]);

  const { goFirst, goLast, goNext, goPrevious, selectedFile, selectedIndex } = useFileNav(
    orderedChangedFiles,
    selectedPath,
    onSelectPath,
  );

  const previousPathRef = useRef(selectedPath);
  useEffect(() => {
    if (previousPathRef.current === selectedPath) return;
    previousPathRef.current = selectedPath;
    setViewMode('diff');
    setDrawerOpen(false);
    setSheetOpen(false);
  }, [selectedPath]);

  useEffect(() => {
    if (tab === 'files') onRequestTree?.();
  }, [tab, onRequestTree]);

  const repoFiles = useMemo<ReviewChangedFile[] | undefined>(() => {
    if (!treeEntries) return undefined;
    const statusByPath = new Map(session.changedFiles.map((file) => [file.path, file]));
    return treeEntries
      .filter((entry) => entry.type === 'file')
      .map((entry) => {
        const change = statusByPath.get(entry.path);
        return {
          path: entry.path,
          status: change?.status ?? entry.status ?? '',
          additions: change?.additions ?? 0,
          deletions: change?.deletions ?? 0,
        };
      });
  }, [treeEntries, session.changedFiles]);

  const handleToggleSidebar = useCallback(() => {
    if (isTablet) {
      setDrawerOpen((current) => !current);
      return;
    }
    if (isMobile) {
      setSheetOpen((current) => !current);
      return;
    }
    const panel = sidebarRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) panel.expand();
    else panel.collapse();
  }, [isMobile, isTablet]);

  const handleFocusFilter = useCallback(() => {
    if (isTablet) {
      setDrawerOpen(true);
    } else if (!isMobile && sidebarRef.current?.isCollapsed()) {
      sidebarRef.current.expand();
    }
    setTab('changes');
    requestAnimationFrame(() => {
      filterInputRef.current?.focus();
      filterInputRef.current?.select();
    });
  }, [isMobile, isTablet]);

  const handleClearFilter = useCallback(() => setFilter(''), []);

  const handleCopyPath = useCallback(() => {
    if (!selectedFile) return;
    void navigator.clipboard?.writeText(selectedFile.path);
  }, [selectedFile]);

  const handleSheetSelect = useCallback(
    (path: string) => {
      onSelectPath(path);
      setSheetOpen(false);
    },
    [onSelectPath],
  );

  const handleOpenDrawer = useCallback(() => setDrawerOpen(true), []);
  const handleCloseDrawer = useCallback(() => setDrawerOpen(false), []);
  const handleOpenSheet = useCallback(() => setSheetOpen(true), []);
  const handleCloseSheet = useCallback(() => setSheetOpen(false), []);

  useKeyboardShortcuts({
    onFirst: goFirst,
    onFocusFilter: handleFocusFilter,
    onLast: goLast,
    onNext: goNext,
    onPrevious: goPrevious,
    onToggleSidebar: handleToggleSidebar,
  });

  const effectiveDiffStyle: DiffStyle = isMobile ? 'unified' : diffStyle;
  const effectiveViewMode: ViewMode = isMobile ? 'diff' : viewMode;

  const sidebar = (
    <Sidebar
      changedFiles={session.changedFiles}
      collapsed={false}
      colorScheme={colorScheme}
      filter={filter}
      filterInputRef={filterInputRef}
      repoFiles={repoFiles}
      repoLoading={treeLoading ?? false}
      selectedPath={selectedPath}
      tab={tab}
      view={view}
      onChangeFilter={setFilter}
      onChangeTab={setTab}
      onChangeView={setView}
      onClearFilter={handleClearFilter}
      onExpand={() => undefined}
      onSelectPath={onSelectPath}
    />
  );

  return (
    <div className={styles.root}>
      <a className={styles.skipLink} href="#review-main">
        Skip to diff
      </a>
      <TitleBar session={session} />
      {isDesktop ? (
        <PanelGroup
          autoSaveId="kagura-review-panel"
          className={styles.panels}
          direction="horizontal"
        >
          <Panel
            collapsible
            collapsedSize={0}
            defaultSize={16}
            maxSize={45}
            minSize={16}
            order={1}
            ref={sidebarRef}
            onCollapse={() => setCollapsed(true)}
            onExpand={() => setCollapsed(false)}
          >
            <Sidebar
              changedFiles={session.changedFiles}
              collapsed={collapsed}
              colorScheme={colorScheme}
              filter={filter}
              filterInputRef={filterInputRef}
              repoFiles={repoFiles}
              repoLoading={treeLoading ?? false}
              selectedPath={selectedPath}
              tab={tab}
              view={view}
              onChangeFilter={setFilter}
              onChangeTab={setTab}
              onChangeView={setView}
              onClearFilter={handleClearFilter}
              onExpand={() => sidebarRef.current?.expand()}
              onSelectPath={onSelectPath}
            />
          </Panel>
          <PanelResizeHandle aria-label="Resize sidebar" className={styles.resizeHandle} />
          <Panel minSize={40} order={2}>
            <RightPane
              baseFile={baseFile}
              colorScheme={colorScheme}
              contentLoading={contentLoading ?? false}
              diff={diff}
              diffStyle={diffStyle}
              file={file}
              selectedFile={selectedFile}
              selectedPath={selectedPath}
              viewMode={viewMode}
              onChangeDiffStyle={setDiffStyle}
              onChangeViewMode={setViewMode}
              onCopyPath={handleCopyPath}
              onNext={goNext}
              onPrevious={goPrevious}
            />
          </Panel>
        </PanelGroup>
      ) : (
        <div className={styles.flatBody}>
          <RightPane
            baseFile={baseFile}
            colorScheme={colorScheme}
            compactBreadcrumb={isMobile}
            contentLoading={contentLoading ?? false}
            diff={diff}
            diffStyle={effectiveDiffStyle}
            file={file}
            hideStylePill={isMobile}
            hideViewModePill={isMobile}
            selectedFile={selectedFile}
            selectedPath={selectedPath}
            viewMode={effectiveViewMode}
            onChangeDiffStyle={setDiffStyle}
            onChangeViewMode={setViewMode}
            onCopyPath={handleCopyPath}
            onNext={goNext}
            onOpenDrawer={isTablet ? handleOpenDrawer : undefined}
            onOpenSheet={isMobile ? handleOpenSheet : undefined}
            onPrevious={goPrevious}
          />
        </div>
      )}
      {isTablet ? (
        <DrawerSidebar open={drawerOpen} onClose={handleCloseDrawer}>
          {sidebar}
        </DrawerSidebar>
      ) : null}
      {isMobile ? (
        <BottomSheetFiles
          files={orderedChangedFiles}
          open={sheetOpen}
          selectedPath={selectedPath}
          onClose={handleCloseSheet}
          onSelect={handleSheetSelect}
        />
      ) : null}
      <StatusBar
        fileTotal={session.changedFiles.length}
        selectedFile={selectedFile}
        selectedIndex={selectedIndex}
      />
    </div>
  );
}
