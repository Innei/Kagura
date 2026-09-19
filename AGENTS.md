# AGENTS.md

Project conventions and guidelines for AI-assisted development on **kagura**.

## Build & Run

| Command                 | Purpose                     |
| ----------------------- | --------------------------- |
| `pnpm dev`              | Development with hot reload |
| `pnpm build`            | Compile TypeScript          |
| `pnpm test`             | Run unit tests (Vitest)     |
| `pnpm test:watch`       | Watch mode for unit tests   |
| `pnpm typecheck`        | Type-check only (no emit)   |
| `pnpm e2e`              | Run all live Slack E2E      |
| `pnpm e2e -- <id>`      | Run specific scenario by id |
| `pnpm e2e -- -i`        | Interactive scenario picker |
| `pnpm e2e -- -l`        | List all discovered cases   |
| `pnpm e2e -- -s <term>` | Search/filter by keyword    |
| `pnpm e2e:list`         | List all discovered cases   |

## Push & Deploy

The repo has an auto-updater (`ops/pm2/update-loop.sh`) that pulls and restarts the bot every 60s. **Always use `ops/pm2/push-with-lock.sh` instead of plain `git push`** — it writes a 120s lock file so the updater defers the restart until the current task finishes.

```bash
# Commit first, then push with lock protection:
git commit -m "..."
./ops/pm2/push-with-lock.sh
```

## Development workflow

Every feature or bugfix **must** include:

1. **Implementation** — source code under `src/`.
2. **Unit tests** — in `tests/*.test.ts`, using Vitest. Mock external dependencies (Slack client, Claude SDK). Test handler logic with in-memory stores.
3. **Live E2E test** — in `src/e2e/live/run-*.ts`. These run against a real Slack workspace with Socket Mode. Follow the existing polling + assertion pattern.

Always run `pnpm build` and `pnpm test` before considering a task complete.

## Code conventions

- **TypeScript strict mode**, ESM-only (`"type": "module"` in package.json).
- **Dependency injection** via function parameters — no global singletons.
- **Zod** for all external input validation (Slack events, tool calls, env vars).
- **No default exports** — use named exports everywhere.
- Store interfaces live in `*/types.ts`; SQLite implementations are separate files.
- Slash command handlers go in `src/slack/commands/`.
- Ingress handlers (mentions, thread replies, assistant) go in `src/slack/ingress/`.
- Interaction handlers (shortcuts, modals, buttons) go in `src/slack/interactions/`.

## Slash commands

Slash commands are registered in `src/slack/commands/register.ts` and auto-synced to the Slack App manifest on startup when `SLACK_APP_ID` is set along with either `SLACK_CONFIG_REFRESH_TOKEN` or `SLACK_CONFIG_TOKEN`.

Token management: Slack config tokens expire every 12 hours. Set `SLACK_CONFIG_REFRESH_TOKEN` (from the Slack App settings page) and the bot will automatically rotate tokens on each startup, persisting the new refresh token to `data/slack-config-tokens.json`.

To add a new slash command:

1. Create `src/slack/commands/<name>-command.ts` with a `handle<Name>Command(text, deps)` function.
2. Add it to the `COMMANDS` array in `register.ts`.
3. Add the manifest entry in `manifest-sync.ts` `DESIRED_COMMANDS`.
4. Write unit tests in `tests/slash-commands.test.ts`.
5. Run `pnpm build && pnpm test`.

## Project structure

```
src/
├── index.ts                    # Entry point
├── application.ts              # Composition root
├── env/server.ts               # Validated env schema
├── logger/                     # Structured logging + redaction
├── db/                         # SQLite + Drizzle schema
├── session/                    # Session persistence
├── memory/                     # Cross-thread memory store
├── workspace/                  # Repo discovery + resolution
├── slack/
│   ├── app.ts                  # Bolt initialization + handler registration
│   ├── commands/               # Slash command handlers (/usage, /workspace, etc.)
│   ├── ingress/                # @mention / thread / assistant handlers
│   ├── interactions/           # Message Action + modal handlers
│   ├── context/                # Thread history loading
│   └── render/                 # Streaming output + UI state
├── claude/
│   ├── executor/               # Agent SDK wrapper + MCP server
│   └── tools/                  # MCP tool definitions
└── schemas/                    # Zod schemas

packages/
└── live-cli/                   # Standalone E2E CLI (commander + @clack/prompts)
    └── src/
        ├── cli.ts              # Entry point, commander program definition
        ├── discovery.ts        # Scenario discovery + filtering
        ├── prompt.ts           # Interactive multi-select via @clack/prompts
        ├── runner.ts           # Serial execution + summary formatting
        └── types.ts            # LiveE2EScenario interface
```

## Testing patterns

### Unit tests (`tests/`)

- Use `vi.mock()` for external modules (`@anthropic-ai/claude-agent-sdk`).
- Create in-memory store implementations (see `createMemorySessionStore()`, `createMemoryStore()` in existing tests).
- Use `createSlackClientFixture()` pattern for mock Slack clients that capture calls.
- Test file names: `tests/<feature>.test.ts`.

### Live E2E tests (`src/e2e/live/`)

- Each scenario is a standalone `run-*.ts` file that exports a `scenario` object with `id`, `title`, `description`, `keywords`, and `run`.
- The CLI lives in `packages/live-cli/` and is built with `commander` + `@clack/prompts`. It auto-discovers scenarios from `src/e2e/live/` and supports serial all-run, interactive multi-select, keyword search, and direct id-based execution.
- Uses `SlackApiClient` to post real messages and poll for replies.
- Follows the pattern: start app → post trigger message → poll until assertions pass or timeout → write result JSON → assert.
- Run a specific scenario: `pnpm e2e -- <scenario-id>`.
- List all scenarios: `pnpm e2e:list` or `pnpm e2e -- --list`.
