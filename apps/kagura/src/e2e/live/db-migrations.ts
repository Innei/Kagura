import { createDatabase } from '~/db/index.js';

export function applyLiveE2EDatabaseMigrations(dbPath: string): void {
  const { sqlite } = createDatabase(dbPath, { migrate: true });
  sqlite.close();
}
