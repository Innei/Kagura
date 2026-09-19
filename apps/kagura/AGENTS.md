# CLAUDE.md — apps/kagura

Notes for AI-assisted development scoped to the `apps/kagura` package. The repo-root [`CLAUDE.md`](../../CLAUDE.md) covers workspace-wide conventions, build/run commands, push/deploy, and live E2E patterns; this file documents subsystems that live entirely under `apps/kagura/src/`.

## Memory & Reconciler

Memory is persisted in SQLite (`memories` table). Two write paths:

- **Claude Code provider:** in-process MCP `save_memory` tool (defined in `src/agent/providers/claude-code/mcp-server.ts`).
- **Codex CLI provider:** model shells out to `kagura-memory save` (`packages/memory-cli`), which writes directly to the same SQLite db. Same for recall via `kagura-memory recall`.

Both paths converge on the same `memories` table.

### Background reconciler

A `MemoryReconciler` runs as a background loop on `KAGURA_MEMORY_RECONCILER_INTERVAL_MS` (default 6h). Each tick:

1. **Prune expired:** `DELETE WHERE expires_at < now`. Always runs, no LLM.
2. **Detect dirty buckets:** compares the `memories` aggregate (per `(scope, category)`) against the `memory_reconcile_state` watermark table. A bucket is "dirty" when:
   - It has never been reconciled, OR
   - Max `created_at` advanced (e.g. external CLI save), OR
   - Row count changed, OR
   - In-process saves bumped `writes_since_reconcile >= KAGURA_MEMORY_RECONCILER_WRITE_THRESHOLD`
3. **LLM consolidation (when enabled):** for each dirty bucket, call an OpenAI-compatible `/chat/completions` endpoint with the bucket's records. The model returns `delete`/`merge`/`rewrite`/`extend_ttl` ops, validated by zod, applied in a single transaction.
4. **Update watermark:** clear `writes_since_reconcile`, record latest max createdAt and count.

LLM consolidation requires `KAGURA_MEMORY_RECONCILER_ENABLED=true` and a non-empty `KAGURA_MEMORY_RECONCILER_API_KEY`. If enabled without a key, the bot logs a warning and runs in prune-only mode.

### Recall is on-demand

Boot-time prompt only injects identity preferences (nicknames, language tone). Other memories load on demand:

- Claude Code: model calls the in-process `recall_memory` MCP tool.
- Codex CLI: model runs `kagura-memory recall --category ... --query ...` via shell.

This keeps the prompt cache stable and ensures reconciler updates take effect immediately without rebooting active sessions.
