import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// Build trusted platform code only. Customer source/config/plugins never enter this process.
// The authoring package's Nx build is cached (a reviewed recipe in workspace-verification.mjs,
// pinned by this file's digest), so the recipe reads no ambient file: no `.env` files and no searched
// PostCSS configuration. The bundler environment it still reads (`VITE_*`, a custom native rolldown
// binding) is hashed by `workspace-runtime.mjs --authoring-build-tools`.
await build({
  configFile: false,
  envDir: false,
  css: { postcss: {} },
  root: fileURLToPath(new URL('../packages/authoring/', import.meta.url)),
  logLevel: 'warn',
  build: {
    emptyOutDir: false,
    target: 'es2022',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      external: (id) => id.startsWith('node:') || builtinModules.includes(id),
      treeshake: { moduleSideEffects: false },
      output: {
        globals: (id) =>
          id === 'node:crypto' || id === 'crypto' ? '__noodleCrypto' : '__noodleDeniedBuiltin',
      },
    },
    lib: {
      entry: fileURLToPath(
        new URL('../packages/authoring/src/sandbox-program.ts', import.meta.url),
      ),
      name: 'NoodleSandboxProgram',
      formats: ['iife'],
      fileName: () => 'sandbox-program.bundle.js',
    },
  },
});
