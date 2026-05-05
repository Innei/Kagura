# Slash commands & controls

## Slash commands

All responses are **ephemeral** (only visible to the invoking user).

| Command                | Description                                                       |
| ---------------------- | ----------------------------------------------------------------- |
| `/usage`               | Show bot stats — session count, memory count, repos, uptime       |
| `/workspace`           | List all available workspaces                                     |
| `/workspace <name>`    | Look up a specific workspace (path, aliases, memory count)        |
| `/memory`              | Show help for memory subcommands                                  |
| `/memory list <repo>`  | List recent memories for a repo                                   |
| `/memory count <repo>` | Show total memory count for a repo                                |
| `/memory clear <repo>` | Clear all memories for a repo                                     |
| `/session`             | Show total session count                                          |
| `/session <thread_ts>` | Inspect a specific session (workspace, provider session, state)   |
| `/version`             | Show deployment info — git commit hash, commit date, deploy date  |
| `/provider`            | Show current agent provider status and available providers        |
| `/provider list`       | List all registered agent providers                               |
| `/provider <id>`       | Switch agent provider for the current thread                      |
| `/provider reset`      | Clear per-thread provider override, revert to default             |
| `/model`               | Show current model status for the thread's active provider        |
| `/model list`          | List models available to the current thread's provider            |
| `/model <name>`        | Override the model for the current thread                         |
| `/model reset`         | Clear per-thread model override, revert to provider default model |

## Provider and model overrides

`/provider` and `/model` are thread-scoped controls. Use them from the Slack thread where you want the change to apply.

- `/provider <id>` accepts registered providers such as `claude-code`, `codex-cli`, and `pi-agent`.
- `/model <name>` accepts any model name supported by the current provider and passes it through on the next agent run.
- `/model list` shows models available to the current provider. Pi Agent uses `pi --list-models`; Codex uses `codex debug models`; Claude Code shows supported aliases/common IDs and the configured default because the Claude CLI does not expose a local model-catalog command.
- Changing the provider clears the thread's model override so a model name from one provider is not accidentally reused with another provider.
- Changing or resetting the model clears the provider session handle; the next message starts a fresh provider session with the selected model.

Provider defaults can be set globally through environment variables or `config.json`, while `/model <name>` is for temporary per-thread overrides.

## Stopping in-progress replies

Three mechanisms are available to cancel an active bot reply. Slack blocks custom slash commands inside threads ([Slack docs](https://docs.slack.dev/interactivity/implementing-slash-commands)), so the thread-local options rely on reactions, shortcuts, or plain-text keywords rather than `/commands`.

| Method               | How to use                                                                                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Keyword reply**    | Post a thread reply whose only content (after trimming punctuation) is `stop` or `cancel` (case-insensitive). The bot cancels the in-progress reply and adds a :octagonal_sign: reaction to your message. |
| **Emoji reaction**   | Add a :octagonal_sign: (`:octagonal_sign:`) or :no_entry_sign: (`:stop_sign:`) reaction to any message in the thread (the trigger message, the bot's progress message, or the thread root)                |
| **Message shortcut** | Right-click (or `...` menu) on any message in the thread -> **Stop Reply**                                                                                                                                |

All three stop active executions in the thread and finalize the bot's progress message as "stopped."

## Reaction lifecycle

The bot uses emoji reactions to signal processing state:

1. When a message is received, the bot adds an **acknowledgement reaction** (configurable via `SLACK_REACTION_NAME`) to indicate it is processing.
2. Once the acknowledgement reaction is removed, the bot starts generating the reply.
3. After the reply is complete, the bot adds a **completion reaction** (configurable via `SLACK_REACTION_DONE_NAME`) to indicate the turn is finished.
