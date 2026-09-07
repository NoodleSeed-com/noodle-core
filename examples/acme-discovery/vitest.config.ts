import { defineConfig } from 'vitest/config';

// Local config so `npm test` (vitest run) discovers this example's own tests instead of inheriting a
// parent monorepo config's include globs.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
});
