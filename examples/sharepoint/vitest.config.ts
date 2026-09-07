import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@noodleseed/one': fileURLToPath(
        new URL('../../packages/authoring/src/index.ts', import.meta.url),
      ),
      '@noodle-borg/connector-defs': fileURLToPath(
        new URL('../../packages/connector-defs/src/schema.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
