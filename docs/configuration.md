# Configuration

## File layout

Kagura reads config from `~/.config/kagura/` by default. Dev mode (running inside the repo) falls back to cwd; `$KAGURA_HOME` overrides both.

- `~/.config/kagura/.env` — secrets (tokens, signing secret, API keys)
- `~/.config/kagura/config.json` — non-secret tunables (provider selection, model options, paths, log level)
- `~/.config/kagura/data/sessions.db` — Drizzle-managed SQLite
- `~/.config/kagura/data/slack-config-tokens.json` — rotating Slack config tokens
- `~/.config/kagura/logs/` — daily log files (if `LOG_TO_FILE=true`)

Precedence when keys overlap: `env > config.json > built-in default`.

## Runtime configuration

Non-secret runtime settings can live in `config.json`:

```bash
cp config.example.json config.json
```

Environment variables still work and take precedence over JSON config:

```text
environment > config.json > built-in defaults
```

Use `.env` for secrets such as Slack tokens. You can point the app at a different JSON file with `APP_CONFIG_PATH`.

Example:

```json
{
  "a2a": {
    "outputMode": "quiet",
    "diagnosticsDir": "./data/a2a-diagnostics"
  },
  "agentTeams": {
    "S0123456789": {
      "name": "kagura-agents",
      "defaultLead": "U0123456789",
      "members": [
        {
          "id": "U0123456789",
          "label": "codex",
          "role": "implementation, verification, and final summary"
        },
        {
          "id": "U9876543210",
          "label": "claude",
          "role": "design review and alternate implementation"
        }
      ]
    }
  },
  "codex": {
    "model": "gpt-5.5",
    "reasoningEffort": "medium",
    "sandbox": "danger-full-access"
  },
  "piAgent": {
    "command": "pi",
    "args": ["-p", "--mode", "json"],
    "model": ""
  },
  "repoRootDir": "~/git",
  "worktreeRootDir": "~/git/kagura-worktrees"
}
```

`piAgent.command` and `piAgent.args` configure the Pi Agent adapter. The default is `pi -p --mode json` so Kagura can render Pi text, tool/plugin activity, usage, and generated artifacts in Slack. If Pi is installed through a shell profile or version manager, set `command` to the absolute executable path or export `PI_AGENT_COMMAND`.

`agentTeams` maps Slack user group IDs (`<!subteam^S...>`) to bot user IDs. `members` can be a list of bot user ID strings or objects with `id`, optional `label`, and optional `role`. Labels and roles are shown in the A2A prompt roster so agents know which peer to mention for implementation, review, or other delegated work. When a message mentions a configured team, only `defaultLead` starts an Agent run; other configured members stay idle until the lead or user explicitly mentions them later in the thread.

`a2a.outputMode` controls how much Agent-to-Agent activity is posted into the Slack thread. `verbose` preserves the legacy behavior. `quiet` buffers non-delegation assistant messages during A2A turns and posts only the final assistant message for the turn; messages that explicitly mention another configured agent still post immediately so delegation continues to work. Buffered messages are written as JSONL files under `a2a.diagnosticsDir` for later incident review.

## Environment variables

```bash
cp .env.example .env
```

### Required

| Variable               | Description                                  |
| ---------------------- | -------------------------------------------- |
| `SLACK_BOT_TOKEN`      | Bot user OAuth token (`xoxb-...`)            |
| `SLACK_APP_TOKEN`      | App-level token for Socket Mode (`xapp-...`) |
| `SLACK_SIGNING_SECRET` | Request verification secret                  |
| `REPO_ROOT_DIR`        | Root directory containing candidate repos    |

### Optional — automatic slash command registration

| Variable                     | Description                                                     |
| ---------------------------- | --------------------------------------------------------------- |
| `SLACK_APP_ID`               | Your Slack App ID (from Basic Information)                      |
| `SLACK_CONFIG_REFRESH_TOKEN` | Configuration refresh token (`xoxe-...`) for automatic rotation |
| `SLACK_CONFIG_TOKEN`         | Configuration access token (fallback, expires every 12h)        |

See [`.env.example`](../.env.example) for all available options including `REPO_SCAN_DEPTH`, `WORKTREE_ROOT_DIR`, `CLAUDE_MODEL`, `ANTHROPIC_BASE_URL`, and logging configuration.

This repository does not require an `ANTHROPIC_API_KEY` environment variable to boot. Claude authentication follows your local Claude Agent SDK / runtime setup. If you want to route Claude Code through a compatible backend such as Kimi, put the corresponding `ANTHROPIC_*` variables in `.env`; live E2E can override the same keys in `.env.e2e`.

The bot scans `REPO_ROOT_DIR` recursively up to `REPO_SCAN_DEPTH`. When it can resolve a repo/path from the conversation, it binds the Slack thread to that concrete workspace path. When no repo is identified, it proceeds without a workspace instead of falling back to the bot process `cwd`.

`WORKTREE_ROOT_DIR` controls the centralized parent directory agents should use for git worktrees. If unset, Kagura defaults it to `REPO_ROOT_DIR/kagura-worktrees`, so a typical setup becomes `~/git/kagura-worktrees`. Override it in `.env` or `config.json` if you want a different shared parent directory.

`reviewPanel` enables the local read-only code review panel. When enabled, Kagura records a review session for each workspace-bound agent execution and posts a Slack button to `/reviews/{executionId}` after a successful run.

The panel offers:

- a sidebar with **Changes** (`M / A / D / R / ??`) and a full **Files** tree, both filterable;
- a **Diff** view (split or unified) with classic indicators, word-level intra-line diff, and per-hunk **↑ / ↓ expand** of collapsed unmodified context — the GitHub muscle memory;
- a **Source** view of the file at `HEAD` with [Shiki](https://shiki.style/) syntax highlighting (TS/JS, Python, Go, Rust, Ruby, Java, Kotlin, Swift, C/C++, PHP, Shell, JSON/YAML/TOML, Markdown, Vue/Svelte, GraphQL, Dockerfile, Makefile, …) and gutter markers for added lines.

It exposes only `GET` endpoints — there is no edit API, no shell, and the `file` endpoint refuses absolute and `..`-traversal paths.

Set `baseUrl` to the domain name or IP address Slack users can reach from their browser. `baseUrl` may include a path prefix such as `https://kagura.example.com/codex`; the review server and Web UI use that prefix for both page and API routes. A full `pnpm build` copies the Web UI into `apps/kagura/dist/review-panel`, the default production assets directory. Override `assetsDir` only when serving a separately built UI.

```json
{
  "reviewPanel": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 3077,
    "baseUrl": "http://127.0.0.1:3077",
    "assetsDir": "./apps/kagura/dist/review-panel"
  }
}
```

### Single-domain multi-instance review panel

When multiple Kagura production instances run on the same host but only one public or LAN domain is available, allocate one path namespace per instance. For example, a local two-bot setup can use:

```json
{
  "reviewPanel": {
    "enabled": true,
    "host": "0.0.0.0",
    "port": 3077,
    "baseUrl": "https://kagura.innei.dev/codex",
    "assetsDir": "./apps/kagura/dist/review-panel"
  }
}
```

and a second instance:

```json
{
  "reviewPanel": {
    "enabled": true,
    "host": "0.0.0.0",
    "port": 3078,
    "baseUrl": "https://kagura.innei.dev/claude",
    "assetsDir": "./apps/kagura/dist/review-panel"
  }
}
```

The reverse proxy should preserve the path prefix when forwarding to the instance, so `/codex/reviews/{executionId}` and `/codex/api/reviews/{executionId}` both reach the `3077` service, while `/claude/...` reaches `3078`. Static assets are shared and may be served from either instance:

```nginx
server {
  listen 443 ssl;
  server_name kagura.innei.dev;

  location /codex/ {
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://10.0.0.89:3077;
  }

  location /claude/ {
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://10.0.0.89:3078;
  }

  location /assets/ {
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://10.0.0.89:3077;
  }
}
```

For LAN access that should bypass a Cloudflare Tunnel, keep the same HTTPS hostname and override DNS locally. With Surge, add this under `[Host]`:

```ini
kagura.innei.dev = 10.0.0.33
```

In this setup `10.0.0.33` is the LAN nginx reverse proxy and `10.0.0.89` is the Mac running the Kagura PM2 instances. Reserve those LAN addresses or update the proxy when DHCP changes them.

### Memory reconciler

Background loop that prunes expired memories and consolidates dirty buckets via an OpenAI-compatible LLM. The loop always runs and prunes `expires_at < now` rows; LLM consolidation is gated separately so you can opt in once the key is provisioned.

| Env var                                    | Default                     | Description                                                                                                                                                        |
| ------------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `KAGURA_MEMORY_RECONCILER_ENABLED`         | `false`                     | Enable LLM consolidation. When `false`, the loop still runs and prunes expired memories.                                                                           |
| `KAGURA_MEMORY_RECONCILER_API_KEY`         | (env-only, optional)        | Bearer token for the OpenAI-compatible API. Required for LLM consolidation; if missing while `ENABLED=true`, falls back to prune-only mode with a startup warning. |
| `KAGURA_MEMORY_RECONCILER_BASE_URL`        | `https://api.openai.com/v1` | Base URL of the chat completions endpoint. Any OpenAI-compatible provider works (DeepSeek, Together, Groq, Ollama, vLLM, …).                                       |
| `KAGURA_MEMORY_RECONCILER_MODEL`           | `gpt-4o-mini`               | Model name passed to the API. Adjust based on `BASE_URL`.                                                                                                          |
| `KAGURA_MEMORY_RECONCILER_INTERVAL_MS`     | `21600000` (6 hours)        | How often the reconcile loop fires.                                                                                                                                |
| `KAGURA_MEMORY_RECONCILER_WRITE_THRESHOLD` | `5`                         | Minimum `writes_since_reconcile` to trigger LLM merge for a bucket. (External CLI saves still trigger via maxCreatedAt drift regardless of this counter.)          |
| `KAGURA_MEMORY_RECONCILER_BATCH_SIZE`      | `50`                        | Max records per bucket sent to the LLM in one call.                                                                                                                |
| `KAGURA_MEMORY_RECONCILER_TIMEOUT_MS`      | `30000`                     | Per-LLM-call timeout.                                                                                                                                              |
| `KAGURA_MEMORY_RECONCILER_MAX_TOKENS`      | `1024`                      | Max tokens for the LLM response.                                                                                                                                   |

`KAGURA_MEMORY_RECONCILER_API_KEY` is the only memory-reconciler key that does **not** fall back to `config.json` — it is env-only for security. The remaining keys can be set via either env or `~/.config/kagura/config.json`:

```json
{
  "memory": {
    "reconciler": {
      "enabled": true,
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-4o-mini",
      "intervalMs": 21600000,
      "writeThreshold": 5,
      "batchSize": 50,
      "timeoutMs": 30000,
      "maxTokens": 1024
    }
  }
}
```

The Codex CLI provider shells out to `kagura-memory` (`packages/memory-cli`) for both `save` and `recall`. The CLI reads `KAGURA_DB_PATH` to locate the SQLite file (defaults to `./data/sessions.db` relative to the working directory); set it explicitly when invoking the CLI from outside the kagura process working dir.

## Slack app manifest

Create a new Slack app at <https://api.slack.com/apps> -> **From a manifest**, then paste the JSON below. Adjust `name` / `display_name` as needed.

<details>
<summary>Click to expand manifest</summary>

```json
{
  "display_information": {
    "name": "cc-001"
  },
  "features": {
    "app_home": {
      "home_tab_enabled": true,
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "bot_user": {
      "display_name": "cc-001",
      "always_online": true
    }
  },
  "oauth_config": {
    "scopes": {
      "user": [
        "canvases:read",
        "canvases:write",
        "channels:history",
        "chat:write",
        "groups:history",
        "im:history",
        "mpim:history",
        "search:read.files",
        "search:read.im",
        "search:read.mpim",
        "search:read.private",
        "search:read.public",
        "search:read.users",
        "users:read",
        "users:read.email"
      ],
      "user_optional": [
        "canvases:read",
        "canvases:write",
        "groups:history",
        "im:history",
        "mpim:history",
        "search:read.files",
        "search:read.im",
        "search:read.mpim",
        "search:read.private"
      ],
      "bot": [
        "commands",
        "app_mentions:read",
        "assistant:write",
        "channels:history",
        "chat:write",
        "files:read",
        "files:write",
        "groups:history",
        "im:history",
        "reactions:read",
        "reactions:write",
        "users:read"
      ]
    },
    "pkce_enabled": false
  },
  "settings": {
    "event_subscriptions": {
      "bot_events": ["app_home_opened", "app_mention", "message.channels", "message.im"]
    },
    "interactivity": {
      "is_enabled": true
    },
    "org_deploy_enabled": false,
    "socket_mode_enabled": true,
    "token_rotation_enabled": false
  }
}
```

</details>

After creation, grab the **Bot Token** (`xoxb-...`), **App-Level Token** (`xapp-...`, with `connections:write`), and **Signing Secret** from the app settings page.

### Home Tab setup

The Home Tab displays a welcome screen with quick-start instructions and usage stats. It requires:

1. **`app_home_opened` event** — Subscribe to this event under **Event Subscriptions** → **Bot Events** in the Slack app settings. It is already included in the manifest above.
2. **Home Tab enabled** — In **App Home** settings, ensure the **Home Tab** checkbox is checked.
3. **`home_tab_enabled: true`** in the manifest's `features.app_home` section (included above).

If you set `SLACK_APP_ID` + `SLACK_CONFIG_REFRESH_TOKEN`, the bot will automatically ensure both `home_tab_enabled` and the `app_home_opened` event subscription are present on startup via manifest sync.

## Automatic manifest sync

When `SLACK_APP_ID` is set along with `SLACK_CONFIG_REFRESH_TOKEN` (or `SLACK_CONFIG_TOKEN`), the bot automatically registers any missing slash commands and shortcuts to the Slack App manifest on startup via the [App Manifest API](https://api.slack.com/reference/manifests). No manual configuration in the Slack dashboard is needed.

**Token rotation:** Slack configuration tokens expire every 12 hours. If you provide `SLACK_CONFIG_REFRESH_TOKEN`, the bot calls [`tooling.tokens.rotate`](https://api.slack.com/methods/tooling.tokens.rotate) on each startup and persists the new token pair to `data/slack-config-tokens.json`. This means you only need to set the refresh token once.

Set `SLACK_CONFIG_TOKEN_STORE_PATH` when running multiple app instances from the same checkout so each Slack App persists its rotated configuration token independently.

To generate the tokens:

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Scroll to **"Your App Configuration Tokens"** (below your app list)
3. Click **Generate Token** -> select your workspace -> **Generate**
4. Copy the **Refresh Token** (`xoxe-...`) into `SLACK_CONFIG_REFRESH_TOKEN`
5. Copy the **App ID** from your app's Basic Information page into `SLACK_APP_ID`

## Running multiple production instances

The production model is one OS process per Slack App. Do not use the `SLACK_BOT_2_TOKEN` / `SLACK_APP_2_TOKEN` E2E variables for production startup; those exist only so live tests can start two apps inside one test process.

Each instance needs its own Slack App credentials and its own local runtime state:

| Per-instance value                           | Why it must be separate                                               |
| -------------------------------------------- | --------------------------------------------------------------------- |
| `SLACK_BOT_TOKEN`                            | Identifies the Slack bot user that receives mentions                  |
| `SLACK_APP_TOKEN`                            | Opens that Slack App's Socket Mode connection                         |
| `SLACK_SIGNING_SECRET`                       | Belongs to that Slack App                                             |
| `SLACK_APP_ID`                               | Required if manifest sync is enabled                                  |
| `SLACK_CONFIG_TOKEN_STORE_PATH`              | Avoids rotated config-token files overwriting each other              |
| `APP_CONFIG_PATH`                            | Lets each Agent use a different provider/model/repo/log configuration |
| `SESSION_DB_PATH` / `sessionDbPath`          | Avoids session collisions because Slack threads share `thread_ts`     |
| `LOG_DIR` / `logDir`                         | Keeps per-Agent logs readable                                         |
| `A2A_DIAGNOSTICS_DIR` / `a2a.diagnosticsDir` | Keeps quiet-mode suppressed A2A messages inspectable per Agent        |

`REPO_ROOT_DIR` can be shared when both Agents should see the same repositories.

Example files:

```bash
.env.cc001
.env.cc002
config.cc001.json
config.cc002.json
```

`.env.cc001`:

```dotenv
NODE_ENV=production
APP_CONFIG_PATH=./config.cc001.json
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
SLACK_APP_ID=A...
SLACK_CONFIG_REFRESH_TOKEN=xoxe-...
SLACK_CONFIG_TOKEN_STORE_PATH=./data/cc001/slack-config-tokens.json
```

`config.cc001.json`:

```json
{
  "defaultProviderId": "claude-code",
  "logDir": "./logs/cc001",
  "repoRootDir": "~/git",
  "sessionDbPath": "./data/cc001/sessions.db",
  "slackConfigTokenStorePath": "./data/cc001/slack-config-tokens.json"
}
```

`.env.cc002`:

```dotenv
NODE_ENV=production
APP_CONFIG_PATH=./config.cc002.json
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
SLACK_APP_ID=A...
SLACK_CONFIG_REFRESH_TOKEN=xoxe-...
SLACK_CONFIG_TOKEN_STORE_PATH=./data/cc002/slack-config-tokens.json
```

`config.cc002.json`:

```json
{
  "defaultProviderId": "codex-cli",
  "logDir": "./logs/cc002",
  "repoRootDir": "~/git",
  "sessionDbPath": "./data/cc002/sessions.db",
  "slackConfigTokenStorePath": "./data/cc002/slack-config-tokens.json"
}
```

### Local shell

`dotenv/config` supports `DOTENV_CONFIG_PATH`, so two compiled instances can be started from the same checkout:

```bash
DOTENV_CONFIG_PATH=.env.cc001 pnpm start
DOTENV_CONFIG_PATH=.env.cc002 pnpm start
```

### PM2

Use two app entries that point at different env files:

```js
module.exports = {
  apps: [
    {
      name: 'kagura-cc001',
      script: 'dist/index.js',
      cwd: __dirname,
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        DOTENV_CONFIG_PATH: '.env.cc001',
      },
    },
    {
      name: 'kagura-cc002',
      script: 'dist/index.js',
      cwd: __dirname,
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        DOTENV_CONFIG_PATH: '.env.cc002',
      },
    },
  ],
};
```

Then run:

```bash
pnpm build
KAGURA_HOME=/path/to/instance-state pnpm db:migrate
pm2 start ecosystem.config.cjs
```

PM2 does not run Drizzle migrations by itself. If your deployment uses a wrapper or updater script, treat `pnpm db:migrate` as a required deploy step after `pnpm install` and before `pm2 startOrReload` / `pm2 reload`. Run it with the same `KAGURA_HOME` (or custom `SESSION_DB_PATH`) as the PM2 app instance so schema changes are applied to the database that instance will open. Kagura does not create or alter application tables on startup; schema changes live in migration files.

### Docker Compose

With containers, give each service a different env file and data volume:

```yaml
services:
  kagura-cc001:
    image: kagura:local
    env_file:
      - .env.cc001
    environment:
      NODE_ENV: production
      REPO_ROOT_DIR: /workspace
    restart: unless-stopped
    volumes:
      - ${HOST_REPO_ROOT:?set HOST_REPO_ROOT}:/workspace
      - kagura_cc001_data:/app/data

  kagura-cc002:
    image: kagura:local
    env_file:
      - .env.cc002
    environment:
      NODE_ENV: production
      REPO_ROOT_DIR: /workspace
    restart: unless-stopped
    volumes:
      - ${HOST_REPO_ROOT:?set HOST_REPO_ROOT}:/workspace
      - kagura_cc002_data:/app/data

volumes:
  kagura_cc001_data: {}
  kagura_cc002_data: {}
```

Build once, run both:

```bash
docker build -t kagura:local .
docker compose up -d
```

## Docker deployment

### Prerequisites

- Docker Engine with the Docker Compose plugin
- A `.env` file with valid Slack credentials
- An absolute host directory containing the repositories you want the bot to scan

### Running with Docker Compose

1. Copy `.env.example` to `.env` if you have not already.
2. Set `REPO_ROOT_DIR=/workspace`.
3. Set `HOST_REPO_ROOT` to the absolute host path that contains your repositories.
4. On Linux, if you expect the bot to edit bind-mounted repositories, set `HOST_UID_GID` to your host `uid:gid` value, for example `1000:1000` (you can inspect it with `id -u` and `id -g`).

To build the image directly:

```bash
docker build -t kagura:local .
```

To start the bot with Compose:

```bash
docker compose up -d --build
```

- SQLite data is persisted in the `slack_cc_bot_data` volume at `/app/data`.
- If you enable `LOG_TO_FILE=true`, add a separate mount if you want log files to survive container replacement.
- Repositories from `HOST_REPO_ROOT` are mounted read-write into `/workspace`.
- No inbound port mapping is required for Slack Socket Mode. Compose still publishes `KAGURA_REVIEW_PANEL_PORT` so the review panel is reachable when `KAGURA_REVIEW_PANEL_ENABLED=true`; set `KAGURA_REVIEW_PANEL_BASE_URL` to the externally reachable URL that Slack users should open.

## Database setup

Run database migrations before first-time startup. The app opens the configured SQLite database but does not create or alter application tables from business code.

For production upgrades that include files under `apps/kagura/drizzle/`, run migrations before reloading the app. Use the same state directory as the running instance:

```bash
KAGURA_HOME=/path/to/instance-state pnpm db:migrate
```

The local PM2 process manager only starts or reloads Node processes; it does not automatically apply Drizzle migrations unless your deployment wrapper explicitly runs this command. For multiple PM2 app instances with separate state directories, run the migration once per state directory before reloading any instance.

If you are developing schema changes, use:

```bash
pnpm db:generate
pnpm db:migrate
```
