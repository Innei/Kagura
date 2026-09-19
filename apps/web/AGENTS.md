# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The web app is the React frontend for kagura's review panel. It loads a review session by execution id from the kagura backend and renders a sidebar of changed files alongside a diff view. See the repo-root `CLAUDE.md` for project-wide conventions.

## Commands

| Command          | Purpose                                                                    |
| ---------------- | -------------------------------------------------------------------------- |
| `pnpm dev`       | Vite dev server proxying `/api` to the kagura backend (3077)               |
| `pnpm dev:mock`  | Dev server with `mock-review-api.ts` plugin — opens `/reviews/mock-review` |
| `pnpm build`     | `panda codegen && vite build`                                              |
| `pnpm typecheck` | `panda codegen && tsc --noEmit`                                            |
| `pnpm preview`   | Preview the built `dist/`                                                  |

`prepare` runs `panda codegen` after install, so `apps/web/styled-system/` rebuilds automatically. Override the backend URL with `KAGURA_REVIEW_PANEL_API_URL`.

## Architecture

**Composition root**: `src/main.tsx` imports `src/index.css` (the Panda layer entry, `@layer reset, base, tokens, recipes, utilities`) and renders `<App>`. `App.tsx` reads the execution id from `getExecutionId()` (URL-based, `/reviews/:id`), then loads the session and diff via `features/review-panel/api/`.

**Layout** (`features/review-panel/components/ReviewLayout.tsx`): a 3-row grid — `<TitleBar>` atop, a `react-resizable-panels` PanelGroup in the middle, `<StatusBar>` at the bottom. The PanelGroup hosts `<Sidebar>` (collapsible — `SidebarTabs` for Changes/Files, `SidebarToolbar` for filter + Tree/Flat pill, `<FileTree>` wrapping `@pierre/trees`) and `<RightPane>` (`DiffToolbar` with Diff/Source + Split/Unified pills, then `<DiffView>` which delegates to `@pierre/diffs/react` `PatchDiff` or `<SourceView>` which reconstructs head-side source from the unified diff and gutters per-line add/del). Keyboard shortcuts (`j`/`k`/`gg`/`G`/`/`/`[`) live in `hooks/use-keyboard-shortcuts.ts`. File-nav state lives in `hooks/use-file-nav.ts`. The Files tab currently shares the `changedFiles` data source with Changes; swap it when a Files-tree backend lands.

**Mock API** (`mock-review-api.ts`): a Vite plugin that handles `/api/reviews/*` in dev when `KAGURA_WEB_MOCK_API=true`. It serves a hardcoded `mock-review` execution. The mock data is the single source of fixture state for visual development — update it when adding new fields to `ReviewSession` / `ReviewChangedFile` (see `features/review-panel/types.ts`).

## Styling — Panda CSS

This app uses **Panda CSS in `template-literal` mode** with hashed atomic classes. Configured via `panda.config.ts`. Output lives in `styled-system/` (gitignored) and is reachable via the tsconfig path alias `styled-system/*`.

**Authoring rules** — read these before touching CSS:

- Component styles live in sibling `X.styles.ts` files exporting `const root = css\`...\``. Components import them as `import \* as styles from './X.styles'`.
- Reference tokens with **`token(group.path)` syntax**, not the documented curly `{group.path}`. The curly form breaks Panda's `astish` parser (curly braces are interpreted as CSS block delimiters in property values). Example: `color: token(colors.fg.muted);`, `padding: token(spacing.2) token(spacing.3);`.
- Token taxonomy in `panda.config.ts`:
  - **Raw**: `colors.neutral.{50…950}`, `colors.diff.{addLight,addDark,delLight,delDark}`, `colors.accent.{light,dark}`, `colors.status.{added,modified,deleted,renamed}{Light,Dark}`, `spacing.{1, 1.5, 2, 2.5, 3, 3.5, 4}` (4–16px), `sizes.control.{xs, sm, md, lg, xl}` (24–36px), `radii.{sm, md}`, `fontSizes.{xs, sm, md, lg}` (12–15px), `fonts.{sans, mono}`, `easings.standard`.
  - **Semantic** (resolves via `_dark` condition): `colors.bg.{canvas, surface, hover, subtle, wash, selected}`, `colors.fg.{default, muted, dim, onSelected}`, `colors.border.{default, subtle, strong}`, `colors.focus.ring`, `colors.diff.{add, del}`, `colors.accent.{fg, bg}`, `colors.status.{added, modified, deleted, renamed}`. Always prefer semantic colors; raw `neutral.*` / `accent.*` / `status.*` are for token definitions only.

**Typography rule (do not violate):**

- **Primary text** (file names, tabs, breadcrumb filename, filter input, code, primary headings) MUST be ≥ 14px → use `fontSizes.md` (14) or `fontSizes.lg` (15).
- **Secondary text** (counts, hints, status bar, branch chip, deltas, kbd hints, pill button labels) MUST be ≥ 12px → use `fontSizes.xs` (12) at minimum. Never go below.
- Pierre/diffs and pierre/trees fonts are injected via the `:root` custom properties in `globalCss` (`--diffs-font-size: 14px`, `--trees-font-size-override: 14px`, `--diffs-font-family`, `--trees-font-family-override`). Update those if scaling code/tree fonts.
- `panda.config.ts` sets `hash` to `false` in development and `true` in production for legible class names while debugging. Do not change this.
- `preflight: true` is enabled. If a Tailwind-style reset breaks an element, add a scoped override under `globalCss` in `panda.config.ts`.

**Theme switch**: the inline script in `index.html` sets `data-theme="light|dark"` on `:root` based on the system preference; `theme/use-color-scheme.ts` keeps it in sync via `matchMedia`. The Panda condition `dark: '[data-theme=dark] &'` flips semantic tokens accordingly.

**`theme/tokens.ts` is intentionally retained** despite duplicating values in `panda.config.ts`. `FileTree.tsx` passes raw color values (`bg.surface`, `fg.default`, `diff.add/del`) into `@pierre/trees`'s `themeToTreeStyles` and CSS variable injection — those need JS-runtime strings, not CSS-var references. Keep the two in sync when changing palette values.

## Conventions

- TypeScript strict, ESM-only, no default exports.
- React 19; use `useSyncExternalStore`, `useCallback`, `useMemo` as appropriate. No state management library.
- Component file names are PascalCase; sibling style file is `X.styles.ts`.
- API calls go through `features/review-panel/api/http.ts`'s `getJson<T>()`. Don't bypass it.
