<div align="center">

<img src="./assets/logo.png" width="180" alt="Kagura" />

# Kagura

_Every thread a stage, every response a dance_

[![npm](https://img.shields.io/npm/v/@innei/kagura?style=flat-square&color=cb3837&logo=npm)](https://www.npmjs.com/package/@innei/kagura)
[![Node version](https://img.shields.io/badge/Node.js->=24-3c873a?style=flat-square)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![pnpm](https://img.shields.io/badge/pnpm-10.33-f69220?style=flat-square)](https://pnpm.io)

</div>

> _In Japanese mythology, Ame-no-Uzume performed a divine dance before the closed doors of Amano-Iwato — the heavenly rock cave where Amaterasu had hidden herself, plunging the world into darkness. Her dance, accompanied by music and laughter, drew the sun goddess back into the world. This was the first **kagura** (神楽) — "the entertainment of the gods."_

**Kagura** brings that spirit to Slack. Run [Anthropic Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) or [OpenAI Codex CLI](https://github.com/openai/codex) natively in your workspace — mention the bot, a configured agent user group, or use a Message Action; Kagura routes the session into the right repository and replies with Slack-native rich text, live progress, and persistent memory.

## Why

Running a coding agent inside Slack requires gluing together thread context, workspace routing, streaming UX, session persistence, and memory — all adapted to Slack's API conventions. **kagura** handles that full lifecycle via [Socket Mode](https://api.slack.com/apis/socket-mode) for both Claude Agent SDK and Codex CLI, so you can focus on the agent's behavior.

## How it works

```
Slack message event / Message Action
  → ignore ordinary channel chatter
  → route direct bot mentions or configured agent user-group mentions
  → resolve target repo
  → load thread history (text + files + images)
  → run agent in repo cwd
  → stream progress → post rich-text reply and generated attachments
  → persist session & memory to SQLite
```

## Features

**Conversation** — Thread-aware multimodal context (text + files + images), session resumption across restarts, layered memory (global / workspace / preferences).

**Memory** — On-demand `save`/`recall` for Claude and Codex through the same SQLite store, plus an optional background reconciler that prunes expired memories and deduplicates dirty buckets with an OpenAI-compatible LLM.

**A2A orchestration** — Mention a configured Slack user group or co-mention multiple agent apps to start a lead-coordinated Agent-to-Agent thread with explicit delegation and final summary.

**Slack UX** — Rich text rendering (headings, lists, code blocks, auto-splitting), live progress indicators, reaction lifecycle, native assistant typing.

**Web review panel** — After every workspace-bound run, Kagura posts a Slack button that opens a read-only code review UI: file tree, changed-files list, GitHub-style split/unified diff with expandable unmodified lines, and a Shiki-highlighted source view. See [§ Review panel](#review-panel).

**Workspace routing** — Each thread binds to a repo/workdir. Auto-detected from message text, or manually chosen via Message Action.

**Agent control** — Pluggable provider registry, per-thread model overrides, stop via `stop`/`cancel` keyword, :octagonal_sign: reaction, or message shortcut, slash commands for introspection (`/usage`, `/workspace`, `/memory`, `/session`, `/version`, `/provider`, `/model`).

**Operations** — Auto-provisioned manifest (message events + commands + shortcuts), online-presence heartbeat, Home tab, Zod-validated inputs, secret redaction in logs.

## Review panel

<div align="center">

<img src="./assets/review-panel/01-overview.png" width="820" alt="All changed files at a glance" />

<sub>All changed files at a glance — every modified file rendered inline with its hunks.</sub>

</div>

Each agent run that touches a workspace is recorded as a review session. Kagura posts a permalink in the thread; opening it loads `/reviews/{executionId}` in your browser:

- **Sidebar** — Changes (`M / A / D / R / ??`) tab plus a full Files tree, filterable, with `j` / `k` / `gg` / `G` navigation and `/` to focus the filter.
- **Diff** — Split or unified, classic indicators, word-level intra-line diff, per-hunk **↑ / ↓ expand** of collapsed unmodified context — exactly the GitHub muscle memory.
- **Source** — Shiki-highlighted file at `HEAD`, with gutter markers for added lines. Languages auto-detected from extension and basename (Python, Go, Rust, Java, Kotlin, Ruby, PHP, Swift, C/C++, Shell, JSON/YAML/TOML, Markdown, Vue, Svelte, GraphQL, Dockerfile, Makefile, …).
- **Read-only** — No edit, no shell, no secrets in URLs. Pure inspection over a local HTTP server.

<div align="center">

<img src="./assets/review-panel/02-split-diff-expand.png" width="820" alt="Split diff with expandable unmodified lines" />

<sub>Split diff with expandable unmodified lines — click ↑ / ↓ on a hunk separator to grow context just like GitHub.</sub>

<br/><br/>

<img src="./assets/review-panel/03-source-python.png" width="820" alt="Source view with Shiki syntax highlighting" />

<sub>Source view — full file at <code>HEAD</code> with Shiki highlighting. Picture shows Python; the same path also handles TS, Go, Rust, Ruby, etc.</sub>

</div>

Configuration for production deploys (host, port, `baseUrl`, single-domain multi-instance routing) lives in [docs/configuration.md § reviewPanel](docs/configuration.md). The dev-time mock binds against the real repo at `HEAD~10..HEAD`, so every status, language, and file-type case is exercised end-to-end without a Slack workspace.

## Memory

Kagura stores durable memory in SQLite and exposes it differently per provider:

- Claude uses the in-process MCP tools `save_memory` and `recall_memory`.
- Codex shells out to `kagura-memory save` and `kagura-memory recall`; the adapter injects the correct `KAGURA_DB_PATH` for the active session database.

The startup prompt only includes identity/preferences by default. Project facts, decisions, observations, and completed-task notes are recalled on demand so the prompt stays small and reconciled memory is visible without restarting the bot.

The optional background reconciler always prunes expired rows. LLM consolidation is enabled separately with `KAGURA_MEMORY_RECONCILER_ENABLED=true` and `KAGURA_MEMORY_RECONCILER_API_KEY`; `BASE_URL` accepts OpenAI-compatible providers. Full settings live in [docs/configuration.md § Memory reconciler](docs/configuration.md#memory-reconciler).

## Install

```bash
npm install -g @innei/kagura
# or: pnpm add -g @innei/kagura
```

Requires Node.js ≥ 24. The package ships three bins: `kagura` (the CLI router + wizard), `kagura-app` (the bot, bypassing the CLI), and `kagura-memory` (direct memory `save`/`recall` helper).

## First run

```bash
kagura
```

`kagura` detects that no configuration exists and launches an interactive wizard:

1. **Select an AI provider** — `claude-code` (Anthropic Claude via [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)), `codex-cli` (OpenAI Codex via the `codex` CLI), or `pi-agent` (Pi Agent via `pi -p --mode json` by default).
2. **Set up your Slack app**
   - **Create a new one** — kagura opens `api.slack.com/apps?new_app=1&manifest_json=…` with the manifest already filled in; click Create → Install. If you have a Slack config token set, it can also call `apps.manifest.create` directly.
   - **Reuse an existing one** — paste the App ID and credentials.
   - **Skip for now** — a `.env` skeleton with commented placeholders is written so you can fill it in later.
3. **Paste tokens** — Bot Token (`xoxb-`), App-Level Token (`xapp-`), and Signing Secret. Each token is live-validated against Slack's `auth.test` before being written.
4. **Point at your repos** — `REPO_ROOT_DIR`, e.g. `~/git`.
5. **Start now** — the wizard offers to launch the bot inline once everything is in place.

Re-run `kagura init` at any time to reconfigure.

## Configuration

Everything lives under `~/.config/kagura/` by default (override with `$KAGURA_HOME`).  
Secrets go in `.env`, tunables go in `config.json`. Precedence: `environment > config.json > built-in default`.  
See [docs/configuration.md](docs/configuration.md) for the full layout, key reference, and `config.json` example.

Git worktrees should be centralized under `REPO_ROOT_DIR/kagura-worktrees` by default; override with `WORKTREE_ROOT_DIR` or `worktreeRootDir` if you want a different parent directory.

Use `/provider` inside a Slack thread to switch the thread's agent provider, and `/model <name>` to override the model for that same thread. `/model list` shows models available to the current provider: Pi uses `pi --list-models`, Codex uses `codex debug models`, and Claude Code shows supported aliases/common IDs plus the configured default.

Long Claude Code threads can accumulate provider-side session history even though Kagura only injects incremental Slack transcript context on resumed turns. Tune `slack.threadHistoryLimit` in `config.json` when needed. If a long thread begins failing repeatedly upstream, `/model reset` clears the provider session handle so the next message starts a fresh provider session.

## Subcommands

| Command                          | What it does                                                        |
| -------------------------------- | ------------------------------------------------------------------- |
| `kagura`                         | Run the bot; launch init wizard if config is incomplete             |
| `kagura init`                    | Run the onboarding wizard unconditionally                           |
| `kagura doctor`                  | Diagnose config + connectivity; exit 0 / 1 / 2 by worst severity    |
| `kagura doctor --json`           | Machine-readable report (for CI / scripts)                          |
| `kagura manifest print`          | Print the kagura-desired Slack manifest (no API call)               |
| `kagura manifest export`         | Fetch the live manifest of your Slack app via config token          |
| `kagura manifest sync`           | Push the kagura-desired manifest into your Slack app                |
| `kagura manifest sync --dry-run` | Show what would change without writing                              |
| `kagura config path`             | Print `~/.config/kagura/` (useful for `$(kagura config path)/.env`) |
| `kagura config path --json`      | Emit `{ configDir, envFile, configJsonFile, dbPath, logDir, … }`    |
| `kagura-memory recall`           | Query global or workspace memory from SQLite                        |
| `kagura-memory save`             | Persist a memory record from scripts or the Codex provider          |
| `kagura --version`               | Print version + commit hash + commit date                           |
| `kagura --help`                  | Show help (works on every subcommand)                               |
| `kagura-app`                     | Run the bot directly, skipping config detection (systemd/Docker)    |

### Common recipes

```bash
# Diagnose why the bot won't start
kagura doctor

# Edit secrets or tunables by hand
$EDITOR "$(kagura config path)/.env"
$EDITOR "$(kagura config path)/config.json"

# Generate a manifest.json you can upload to Slack manually
kagura manifest print > manifest.json

# After changing desired scopes / commands, push to Slack
kagura manifest sync --dry-run
kagura manifest sync
```

### Prerequisites

- A Slack workspace where you can create apps.
- **Socket Mode** enabled on the app (the manifest template does this automatically).
- The AI CLI you picked logged in and ready:
  - Claude: run `claude login` first, or set `ANTHROPIC_API_KEY`.
  - Codex: run `codex login` first, or set `OPENAI_API_KEY`.

If something is off, `kagura doctor` will tell you which check failed.

## Getting started (development)

```bash
git clone https://github.com/Innei/kagura.git
cd kagura
pnpm install
cp .env.example .env # fill in SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET, REPO_ROOT_DIR
pnpm dev             # or: pnpm build && pnpm start
```

### Review panel development

```bash
pnpm dev:review      # bot API on 3077, Vite UI on 5173, Slack links point to Vite
pnpm dev:review:mock # Web UI only, backed by the real repo at HEAD~10..HEAD
```

Open <http://127.0.0.1:5173/reviews/mock-review> for the mock panel. The mock plugin uses your current working tree against `HEAD~10` (override with `KAGURA_WEB_MOCK_BASE_REF`) so all status, language, and file-type cases come from real git data. Deep-link directly into a file with `?path=<rel>` and pre-pick a view with `&view=source|diff`.

When the bot starts with the review panel enabled, its dev log prints both the local API listener and the UI base URL used in Slack review links.

For multi-instance production on one domain, give each instance a path-prefixed `reviewPanel.baseUrl`, for example `https://kagura.innei.dev/codex` and `https://kagura.innei.dev/claude`, and route those prefixes to separate local ports in nginx or Cloudflare Tunnel. See [docs/configuration.md](docs/configuration.md#single-domain-multi-instance-review-panel).

## Documentation

| Document                                            | Contents                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [Configuration](docs/configuration.md)              | Environment variables, Slack manifest, token rotation, Docker                                    |
| [Architecture](docs/architecture.md)                | Composition root, agent providers, rendering, workspace routing, memory model, project structure |
| [Agent-to-Agent (A2A)](docs/a2a.md)                 | A2A orchestration, routing rules, quiet mode, and live cases                                     |
| [Slash commands & controls](docs/slash-commands.md) | All slash commands, stop controls, reaction lifecycle                                            |
| [Live E2E testing](docs/e2e-testing.md)             | E2E setup, environment, running scenarios                                                        |
| [Specs](docs/specs/)                                | Detailed subsystem specifications                                                                |

## Scripts

| Command                       | Description                   |
| ----------------------------- | ----------------------------- |
| `pnpm dev`                    | Run with nodemon + tsx        |
| `pnpm build`                  | Compile TypeScript            |
| `pnpm build:web`              | Build the review Web UI       |
| `pnpm test`                   | Run Vitest test suite         |
| `pnpm start`                  | Run compiled output           |
| `pnpm typecheck`              | Type-check without emitting   |
| `pnpm e2e`                    | Run all live Slack E2E cases  |
| `pnpm e2e -- <id>`            | Run a specific scenario by id |
| `pnpm e2e -- --interactive`   | Interactive scenario picker   |
| `pnpm e2e -- --list`          | List all discovered scenarios |
| `pnpm e2e -- --search <term>` | Search/filter by keyword      |
| `pnpm db:generate`            | Generate Drizzle migrations   |
| `pnpm db:migrate`             | Apply migrations              |
| `pnpm db:studio`              | Open Drizzle Studio           |

## License

MIT © Innei, Released under the MIT License.

> [Personal Website](https://innei.in/) · GitHub [@Innei](https://github.com/innei/)
