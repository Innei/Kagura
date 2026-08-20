import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import * as schema from './schema.js';

export interface CreateDatabaseOptions {
  migrate?: boolean;
}

export function createDatabase(dbPath: string, options?: CreateDatabaseOptions) {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');

  const db = drizzle(sqlite, { schema });
  if (options?.migrate) {
    migrate(db, { migrationsFolder: resolveMigrationsFolder() });
  }

  return { db, sqlite };
}

export type AppDatabase = ReturnType<typeof createDatabase>['db'];

export function resolveMigrationsFolder(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Built package: dist/*.js -> ../drizzle
    path.resolve(moduleDir, '../drizzle'),
    // tsx/dev source: src/db/index.ts -> ../../drizzle
    path.resolve(moduleDir, '../../drizzle'),
    path.resolve(process.cwd(), 'drizzle'),
    path.resolve(process.cwd(), 'apps/kagura/drizzle'),
  ];

  const migrationsFolder = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, 'meta', '_journal.json')),
  );
  if (!migrationsFolder) {
    throw new Error(
      `Unable to locate Drizzle migrations folder. Checked: ${candidates.join(', ')}`,
    );
  }

  return migrationsFolder;
}
