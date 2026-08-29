# Slack Agent Platform Migration — Design

Date: 2026-08-29
Status: Approved for planning

## Background

Slack deprecates the Assistant messaging experience (`assistant_view`) in
February 2027 and replaces the `assistant.threads.*` methods with the Agent
Sessions API. Kagura currently sits entirely on the deprecated path:
`slack/app.ts` constructs `new Assistant({...})`, and `SlackRenderer` drives
thread status through `assistant.threads.setStatus`.

Two further platform capabilities are worth adopting in the same pass because
they touch the same code: append-only text streaming (`chat.startStream` /
`chat.appendStream` / `chat.stopStream`), and the `agent_session_stopped` event
that renders a native stop button while a session is in `processing`.

## Scope

In scope:

1. `assistant_view` → `agent_view`, `assistant.threads.*` → `agents.sessions.*`.
2. Real token streaming for the final assistant reply, via a new
   `assistant-message-delta` execution event.
3. `agent_session_stopped` wired to the existing execution registry.

Out of scope (explicitly declined):

- `task_card` / `plan` Block Kit rework for progress display. The progress
  message keeps its current `chat.update` mechanism and existing plan blocks.
- Slack MCP server and Real-time Search (RTS) API.

## Decisions Taken

- **Hard cutover, no feature flag.** `agent_view` replaces `assistant_view`
  outright; the `Assistant` code path is deleted rather than kept behind an env
  switch. Under `agent_view` a conversation behaves as a normal DM with
  in-thread replies, which matches the existing `app_mention` path, so the two
  ingress routes converge instead of diverging.
- **Streaming means real deltas.** A new event type carries incremental text.
  Providers that do not emit deltas fall back to the current whole-message post,
  with no behavioral regression.
- **All existing stop entry points are retained.** The native stop button only
  appears inside an agent session; channel `@mention` executions still rely on
  the stop reaction and the message action.
- **`suspended` status is in scope.** Waiting on a permission prompt or a skill
  question sets the session to `suspended`.
- **Stream flush window is 300 ms.** Configurable via constructor option.

## Preconditions

The Slack app is already declared as an agent in app settings, which grants
`assistant:write`. `agents.sessions.*` calls would fail outright without this,
so `manifest-sync` logs an explicit error (never a silent skip) if the manifest
comes back without the agent declaration.

## Component 1 — Manifest and app declaration

`slack/commands/manifest-sync.ts` already follows an additive
"diff the exported manifest, add what is missing" pattern with `DESIRED_COMMANDS`,
`DESIRED_SHORTCUTS`, and `DESIRED_BOT_EVENTS`. The migration extends that pattern:

- Enable `features.agent_view` when the exported manifest does not have it.
- Add `agent_session_stopped` to `DESIRED_BOT_EVENTS`.
- Ensure `assistant:write` and `chat:write` are present in
  `oauth_config.scopes.bot`.
- Log an error when the exported manifest shows the app is not declared as an
  agent, since every Component 2 call depends on it.

The existing `OBSOLETE_BOT_EVENTS` / `OBSOLETE_BOT_SCOPES` removal lists are
untouched.

## Component 2 — Agent Sessions replaces Assistant threads

### Client interface

`slack/types.ts` models the Slack client narrowly as `SlackWebClientLike` so
tests can supply fixtures. The `assistant: SlackAssistantApi` member is replaced
by:

```ts
export interface SlackAgentSessionsApi {
  setStatus: (args: {
    channel_id: string;
    thread_ts: string;
    status: 'processing' | 'active' | 'suspended' | 'closed';
    title?: string;
    loading_messages?: string[];
  }) => Promise<unknown>;
}

export interface SlackAgentsApi {
  sessions: SlackAgentSessionsApi;
}
```

The installed `@slack/web-api` is 7.15.1, which has no `agents.*` methods. A thin
adapter in `slack/agents-sessions-adapter.ts` implements `SlackAgentsApi` on top
of `client.apiCall('agents.sessions.setStatus', ...)`. When the SDK ships typed
methods, only the adapter body changes; no call site moves.

### Renderer

`SlackRenderer` calls `setStatus` in three places
(`slack-renderer.ts:162`, `:197`, `:226`). These collapse into one private
method that takes a status and optional loading messages, so the status
vocabulary lives in exactly one place. The thinking-status rotation in
`slack/thinking-messages.ts` and the `toSlackStatusFragment` "is …" prefixing are
unchanged — Slack renders agent session status the same way.

Status mapping:

| Moment                                  | Session status |
| --------------------------------------- | -------------- |
| Execution starts                        | `processing`   |
| Reply delivered, awaiting next prompt   | `active`       |
| Waiting on permission or skill question | `suspended`    |
| Execution stopped or failed             | `active`       |

Sessions time out after one hour in `processing`; long executions therefore
re-assert `processing` on each progress update, which the existing status
rotation already does on an interval.

### Suspended plumbing

`SlackPermissionBridge.requestPermission` already receives a client and a
`channelId`, so it can set `suspended` directly and restore `processing` in
`handleAction`.

`SlackUserInputBridge.awaitAnswer` has neither. Rather than thread a full client
through it, both bridges take one optional constructor dependency:

```ts
type AgentSessionStatusSetter = (args: {
  channelId: string;
  threadTs: string;
  status: 'processing' | 'suspended';
}) => Promise<void>;
```

implemented by `SlackRenderer` and injected at the composition root. `awaitAnswer`
gains a `channelId` parameter. This keeps both bridges testable without a Slack
client fixture and matches the project's function-parameter DI convention.

### App wiring

`slack/app.ts` drops `new Assistant({...})` and `app.assistant(assistant)`.
`slack/ingress/assistant-message-handler.ts` is reworked:

- `createAssistantThreadStartedHandler` (suggested prompts) moves to the agent
  suggested-prompts surface; the three default prompts are unchanged. The exact
  replacement for Bolt's `setSuggestedPrompts` under `agent_view` is verified
  against the live SDK during implementation; if no equivalent exists yet, the
  prompts are dropped rather than emulated, and that is called out in the PR.
- `createAssistantUserMessageHandler`'s body — `SlackMessageSchema` parsing,
  identifier extraction, foreign-mention filtering, pending-user-input reply
  handling, dispatch — is preserved and re-registered on the ordinary `message`
  event path, since under `agent_view` agent DMs arrive as normal messages.

The file is renamed to `agent-message-handler.ts` to stop advertising the
deprecated surface.

## Component 3 — Streaming the final reply

### Event model

`agent/types.ts` gains:

```ts
| { type: 'assistant-message-delta'; text: string }
```

The claude-code adapter already runs with `includePartialMessages: true` and
already consumes `content_block_delta` in
`agent/providers/claude-code/runtime-ui.ts` for tool-use UI. Text deltas are
split out of that same stream and emitted. The codex-cli and pi-agent adapters
are not modified and simply never emit the new event.

### StreamingReply

New `slack/render/streaming-reply.ts` owning one stream's lifecycle:

- `start()` → `chat.startStream({ channel, thread_ts, recipient_user_id, recipient_team_id })`,
  returning the stream `ts`.
- `append(text)` → coalesces into a buffer, flushing on a 300 ms timer or when
  the buffer exceeds a character threshold, then `chat.appendStream`. Per-token
  calls would blow through rate limits, so coalescing is mandatory, not an
  optimization. The window and threshold are constructor options.
- `finish(blocks?)` → flushes any remainder and calls `chat.stopStream`, whose
  `blocks` argument appends the trailing toolbar / usage / review-panel blocks
  that `postThreadReply` renders today.

`recipient_user_id` and `recipient_team_id` are required outside DMs; both are
already available on the ingress path.

### Activity sink integration

`slack/ingress/activity-sink.ts` has a single choke point,
`postAssistantMessage(text)`. It becomes:

- On the first `assistant-message-delta` of a turn, open a `StreamingReply` and
  append; subsequent deltas append.
- The terminating `assistant-message` event closes the open stream via `finish()`
  instead of posting. It must not post a second copy of the text.
- If no delta arrived in the turn, `postAssistantMessage` runs exactly as it does
  today via `renderer.postThreadReply`.

The progress message path (`upsertThreadProgressMessage`,
`finalizeThreadProgressMessage`, `finalizeThreadProgressMessageStopped`) is
untouched and stays on `chat.update`.

A stream's `ts` is an ordinary message timestamp, so the acknowledgement
reaction, `appendSessionUsageInfoToThreadReply`, and execution recovery continue
to work against it without change.

Turn-scoped toolbar state (`hasSentToolbarInTurn`, `toolbarReply`,
`lastAssistantReply`) is preserved: the stream's `ts` populates
`lastAssistantReply` on `finish()`.

## Component 4 — Native stop

New `slack/ingress/agent-session-stopped-handler.ts`:

- Subscribes to `agent_session_stopped`.
- Resolves `thread_ts` and calls
  `threadExecutionRegistry.stopByMessage(thread_ts, 'user_stop')`. The registry
  already resolves a thread timestamp directly, so no new registry method is
  needed.
- Slack does not transition session status on stop, so the handler sets the
  session back to `active` itself.

`slack/interactions/stop-message-action.ts` and
`slack/ingress/reaction-stop-handler.ts` are unchanged and remain registered.

## Error handling

- Every `agents.sessions.*` call is wrapped by the existing `withSlackTiming`
  timeout helper and failures are logged without aborting the execution, matching
  how `assistant.threads.setStatus` failures are treated today.
- If `chat.startStream` fails, the turn falls back to `postThreadReply` with the
  accumulated text, so a streaming outage degrades to current behavior rather
  than losing the reply.
- If `chat.appendStream` fails mid-stream, the buffer is retained and retried on
  the next flush; a failure at `finish()` falls back to `postThreadReply` with the
  full accumulated text.
- `agent_session_stopped` for an unknown thread is a no-op with an info log, the
  same as the reaction stop handler.

## Testing

Unit tests (`apps/kagura/tests/`):

- `streaming-reply.test.ts` — coalescing window, character threshold, remainder
  flush on `finish`, `startStream` failure fallback, mid-stream append failure
  retry.
- `agent-session-stopped.test.ts` — registry call, unknown-thread no-op, status
  reset.
- `agent-sessions-adapter.test.ts` — argument shape passed to `apiCall`.
- Extend `manifest-sync.test.ts` — `agent_view`, the new bot event, scope
  presence, and the not-declared-as-agent error log.
- Extend `slack-renderer.test.ts` and `slack-loading-status.test.ts` — status
  vocabulary and the collapsed `setStatus` method.
- Extend `activity-sink.test.ts` — delta path versus no-delta fallback, no
  double post.
- Extend `slack-permission-bridge.test.ts` and `slack-user-input-bridge.test.ts`
  — `suspended` set and restored.

The shared `createSlackClientFixture` helper in `slack-loading-status.test.ts`
gains `chat.startStream` / `appendStream` / `stopStream` and `agents.sessions.*`
capture.

Live E2E (`apps/kagura/src/e2e/live/`):

- `run-plan-block-progress.ts` is updated for the renderer signature change.
- New `run-streaming-reply.ts` asserting an incrementally updated reply message
  that settles on the complete text.

## Sequencing

1. Component 1 and 2 — manifest, adapter, renderer, app wiring, suspended.
2. Component 4 — depends on the manifest event subscription from step 1.
3. Component 3 — independent of the others; can land before or after.

Estimated 2.5 days total.
