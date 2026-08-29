# Live E2E testing

The repository includes a real Slack <-> Claude live E2E runner that starts the local Socket Mode app, posts a real `@mention` into a dedicated Slack channel, waits for the agent-backed reply, and records every Agent Sessions status payload to a local JSONL probe.

## Prerequisites

- A dedicated Slack test channel ID for `SLACK_E2E_CHANNEL_ID`
- A user token for `SLACK_E2E_TRIGGER_USER_TOKEN` that can post into that channel
- The existing bot token must already be installed in that channel and have the scopes listed in the [Slack app manifest](configuration.md#slack-app-manifest)

Recommended safety setup:

- Use a dedicated Slack channel for live E2E traffic
- Use a dedicated test user/token for the trigger account
- Avoid reusing production channels because the runner posts real messages

## Environment

Copy the example and fill in real values:

```bash
cp .env.e2e.example .env.e2e
```

| Variable                       | Description                                        |
| ------------------------------ | -------------------------------------------------- |
| `SLACK_E2E_CHANNEL_ID`         | Dedicated Slack channel for E2E traffic            |
| `SLACK_E2E_TRIGGER_USER_TOKEN` | User token that can post into the test channel     |
| `SLACK_BOT_TOKEN`              | Bot token for the E2E Slack app (overrides `.env`) |
| `SLACK_APP_TOKEN`              | App token for the E2E Slack app (overrides `.env`) |
| `SLACK_SIGNING_SECRET`         | Signing secret for the E2E app (overrides `.env`)  |

If you need a different Claude Code-compatible backend for live E2E, put the normal runtime keys directly into `.env.e2e`. Because that file is loaded with `override: true`, keys such as `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_BASE_URL` replace the values from `.env` only during live test runs.

Example:

```bash
ANTHROPIC_AUTH_TOKEN=...
ANTHROPIC_BASE_URL=https://api.kimi.com/coding/
ANTHROPIC_MODEL=kimi-for-coding
ANTHROPIC_DEFAULT_HAIKU_MODEL=kimi-for-coding
ANTHROPIC_DEFAULT_SONNET_MODEL=kimi-for-coding
ANTHROPIC_DEFAULT_OPUS_MODEL=kimi-for-coding
```

See [`.env.e2e.example`](../.env.e2e.example) for all available options. E2E configuration is kept in `.env.e2e` (separate from the main `.env`) and loaded with `override: true`, so the E2E bot tokens replace the main tokens only during E2E runs without ever touching `.env`.

## Running

```bash
# Run all scenarios serially (default)
pnpm e2e

# Run a specific scenario by id
pnpm e2e -- slash-commands

# Interactive scenario picker
pnpm e2e -- --interactive

# List all discovered scenarios
pnpm e2e -- --list

# Search/filter scenarios by keyword
pnpm e2e -- --search workspace
```

The CLI auto-discovers `run.ts` and `run-*.ts` files under `src/e2e/live/` and runs them serially. Each scenario manages its own application lifecycle, cleanup, and result artifacts.

Recent scenarios cover rich text rendering, long reply splitting, workspace label attachment, clearing the thinking state after reply, retained progress summaries, cross-session preference memory recall, reaction-based stop, and reaction lifecycle.
