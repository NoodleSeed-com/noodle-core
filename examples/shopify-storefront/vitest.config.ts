import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@noodleseed/one': fileURLToPath(
        new URL('../../packages/authoring/src/index.ts', import.meta.url),
      ),
      '@noodle-borg/capabilities': fileURLToPath(
        new URL('../../packages/capabilities/src/index.ts', import.meta.url),
      ),
      '@noodle-borg/compiler': fileURLToPath(
        new URL('../../packages/compiler/src/index.ts', import.meta.url),
      ),
      '@noodle-borg/compute': fileURLToPath(
        // Compute spawns its worker beside the emitted module; source aliases point at a nonexistent
        // `src/worker-entry.js` and cannot exercise the real worker-thread boundary.
        new URL('../../packages/compute/dist/index.js', import.meta.url),
      ),
      '@noodle-borg/connector-defs': fileURLToPath(
        new URL('../../packages/connector-defs/src/index.ts', import.meta.url),
      ),
      '@noodle-borg/connector-http': fileURLToPath(
        new URL('../../packages/connector-http/src/index.ts', import.meta.url),
      ),
      '@noodle-borg/runtime': fileURLToPath(
        new URL('../../packages/runtime/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
