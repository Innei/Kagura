import { createDatabase } from '~/db/index.js';

export function createTestDatabase() {
  return createDatabase(':memory:', { migrate: true });
}
