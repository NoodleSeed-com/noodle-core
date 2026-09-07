import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@noodleseed/one': new URL('../../packages/authoring/src/index.ts', import.meta.url).pathname,
      '@noodle-borg/capabilities': new URL(
        '../../packages/capabilities/src/index.ts',
        import.meta.url,
      ).pathname,
      '@noodle-borg/compiler': new URL('../../packages/compiler/src/index.ts', import.meta.url)
        .pathname,
      '@noodle-borg/compute': new URL('../../packages/compute/src/index.ts', import.meta.url)
        .pathname,
      '@noodle-borg/connector-defs': new URL(
        '../../packages/connector-defs/src/index.ts',
        import.meta.url,
      ).pathname,
      '@noodle-borg/connector-http': new URL(
        '../../packages/connector-http/src/index.ts',
        import.meta.url,
      ).pathname,
      '@noodle-borg/runtime': new URL('../../packages/runtime/src/index.ts', import.meta.url)
        .pathname,
    },
  },
  test: { include: ['test/**/*.test.ts'] },
});
