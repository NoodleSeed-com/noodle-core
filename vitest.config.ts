import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Bound nested builds/browser consumers on the hosted verifier and smaller local machines.
    maxWorkers: Math.min(4, availableParallelism()),
    // Same budget as the private workspace: sandbox compiles and spawned servers exceed the 5 s
    // default on a loaded verifier (2026-09-21: a draft-compiler test timed out at 5 s in
    // projection-verify and reverted an unrelated merge). Hangs still fail, just later.
    testTimeout: 30_000,
    // Hooks that open a database pool and create a schema exceed the 10 s default on a loaded runner.
    hookTimeout: 30_000,
    include: [
      'packages/{agent-kit,assistant,auth,authoring,capabilities,compiler,compute,connector-defs,connector-http,developer-mcp,external-credential-provider,module,module-audit,openapi-import,protocol,runtime,service,transport-http,wire-contracts}/test/**/*.test.ts',
      'packages/cli/test/{apps,cli,dev,project,validate,react-widget-build}.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'packages/service/test/console-create-deploy.test.ts',
    ],
  },
});
