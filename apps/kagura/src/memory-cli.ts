#!/usr/bin/env node
import { randomUUID } from 'node:crypto';

import { Command } from 'commander';
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';

import { createDatabase } from './db/index.js';
import { memories } from './db/schema.js';

function defaultDbPath(): string {
  return process.env.KAGURA_DB_PATH ?? './data/sessions.db';
}

const program = new Command();
program.name('kagura-memory').description('Kagura memory CLI').version('0.0.1');

program
  .command('recall')
  .description('Search memories')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .option('--query <text>', 'Substring to match')
  .option('--category <name>', 'preference|context|decision|observation|task_completed')
  .option('--scope <scope>', 'global|workspace', 'global')
  .option('--repo-id <id>', 'workspace repo id')
  .option('--limit <n>', 'max records', '10')
  .action((opts) => {
    const limit = Math.max(1, Math.min(50, Number(opts.limit) || 10));
    const { db, sqlite } = createDatabase(opts.db, { migrate: true });

    try {
      const nowIso = new Date().toISOString();
      const repoCondition =
        opts.scope === 'workspace' && opts.repoId
          ? eq(memories.repoId, opts.repoId)
          : isNull(memories.repoId);
      const conds: Array<Parameters<typeof and>[number]> = [
        repoCondition,
        or(isNull(memories.expiresAt), gt(memories.expiresAt, nowIso)),
      ];
      if (opts.category) conds.push(eq(memories.category, opts.category));
      if (opts.query) {
        const escaped = String(opts.query)
          .toLowerCase()
          .replaceAll('\\', '\\\\')
          .replaceAll('%', '\\%')
          .replaceAll('_', '\\_');
        conds.push(sql`lower(${memories.content}) like ${`%${escaped}%`} escape '\\'`);
      }

      const rows = db
        .select()
        .from(memories)
        .where(and(...conds))
        .orderBy(desc(memories.createdAt))
        .limit(limit)
        .all();
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    } catch (error) {
      console.error('Query failed:', error instanceof Error ? error.message : error);
      process.exitCode = 1;
    } finally {
      sqlite.close();
    }
  });

program
  .command('save')
  .description('Save a memory record')
  .requiredOption('--category <name>', 'preference|context|decision|observation|task_completed')
  .requiredOption('--content <text>', 'memory content')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .option('--scope <scope>', 'global|workspace', 'global')
  .option('--repo-id <id>', 'workspace repo id')
  .option('--thread-ts <ts>', 'slack thread ts')
  .option('--expires-at <iso>', 'ISO datetime')
  .action((opts) => {
    if (opts.scope === 'workspace' && !opts.repoId) {
      console.error('--repo-id required when --scope=workspace');
      process.exit(2);
    }

    const { db, sqlite } = createDatabase(opts.db, { migrate: true });
    const id = randomUUID();
    const createdAt = new Date().toISOString();

    try {
      db.insert(memories)
        .values({
          id,
          repoId: opts.scope === 'workspace' ? opts.repoId : null,
          threadTs: opts.threadTs ?? null,
          category: opts.category,
          content: opts.content,
          metadata: null,
          createdAt,
          expiresAt: opts.expiresAt ?? null,
        })
        .run();
    } catch (error) {
      console.error('Insert failed:', error instanceof Error ? error.message : error);
      process.exitCode = 1;
      return;
    } finally {
      sqlite.close();
    }

    process.stdout.write(
      `${JSON.stringify({
        id,
        content: opts.content,
        category: opts.category,
        scope: opts.scope,
        ...(opts.scope === 'workspace' ? { repoId: opts.repoId } : {}),
        createdAt,
        ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
      })}\n`,
    );
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
