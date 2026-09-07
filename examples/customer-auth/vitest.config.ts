import { defineConfig } from 'vitest/config';

// Keep the flagship's own contract test executable instead of inheriting the monorepo package-only glob.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
});
