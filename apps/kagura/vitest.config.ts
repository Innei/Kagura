import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __GIT_HASH__: JSON.stringify('abc1234def5678'),
    __GIT_COMMIT_DATE__: JSON.stringify('2026-01-01T00:00:00+00:00'),
  },
  resolve: {
    // tsconfig.json only includes src/**, so tsconfigPaths does not map `~/*`
    // for importers under tests/.
    alias: { '~': fileURLToPath(new URL('./src', import.meta.url)) },
    tsconfigPaths: true,
  },
  test: {
    clearMocks: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    restoreMocks: true,
    setupFiles: ['./tests/setup-env.ts'],
  },
});
