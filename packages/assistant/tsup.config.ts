import { defineConfig } from 'tsup';

// Dual ESM+CJS build for the one package that must meet arbitrary customer toolchains
// (docs/roadmap/embedded-assistant-hardening.md S3). Element registration is idempotent
// (customElements.get guard), so the dual-package hazard cannot double-register.
const NO_BARE_SPECIFIERS = [
  /^@ai-sdk\//,
  '@modelcontextprotocol/ext-apps',
  '@opentelemetry/api',
  'ai',
  'dompurify',
  'marked',
  /^zod(?:\/|$)/,
];

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      'app-view': 'src/app-view.ts',
      client: 'src/client.ts',
      react: 'src/react.ts',
      'react/client': 'src/react-client.ts',
      server: 'src/server.ts',
    },
    format: ['esm', 'cjs'],
    dts: {
      // tsup's dts worker injects `baseUrl`, which TypeScript 6 deprecates (TS5101).
      compilerOptions: { ignoreDeprecations: '6.0' },
    },
    sourcemap: true,
    clean: true,
    outDir: 'dist',
    // The Web Component and DOM-free client entries are consumed directly by browsers.
    // Bundle their runtime graphs so emitted ESM never contains bare specifiers that
    // require a customer import map.
    noExternal: NO_BARE_SPECIFIERS,
  },
  // The script-tag build, served by the hosted service at GET /v1/assistant/embed.js. A separate config
  // because it is the one entry a browser loads directly as a classic script: IIFE so `async` works and
  // no import map is needed, and `clean: false` so it does not wipe the ESM+CJS output above.
  {
    entry: { embed: 'src/embed.ts' },
    format: ['iife'],
    platform: 'browser',
    dts: false,
    // No sourcemap: the route serves only the script, so a `sourceMappingURL` would 404 in devtools
    // and the map alone is four times the bundle in the published tarball.
    sourcemap: false,
    clean: false,
    minify: true,
    outDir: 'dist',
    define: { 'process.env.NODE_ENV': '"production"' },
    noExternal: NO_BARE_SPECIFIERS,
  },
]);
