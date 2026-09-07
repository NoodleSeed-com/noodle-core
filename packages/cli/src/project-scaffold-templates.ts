/**
 * Project scaffold templates: the file maps `noodle init` writes for the `hello` and `http-api` starters,
 * plus the shared `commonFiles`/`title`/`manifestName` helpers. The larger `widget` starter lives in
 * `widget-scaffold-template.ts`. Extracted from project.ts so the config/link module stays under the size
 * gate; this module owns only the generated file *content*. Types come from project.ts (type-only, no
 * runtime cycle).
 */
import type { InitTemplate, ProjectAgentTarget } from './project.js';
import { SCAFFOLD_MODELS, scaffoldEnvironment } from './project-scaffold-model.js';
import { scaffoldBehaviorTest } from './project-scaffold-test-template.js';
import { projectDependencyPins } from './project-toolchain.js';
import { currentCliVersion } from './update.js';

export function title(value: string): string {
  return value
    .split('-')
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}
export function manifestName(value: string): string {
  return value.replace(/-/g, '_');
}
export function helloFiles(
  name: string,
  agentTargets: readonly ProjectAgentTarget[],
): Record<string, string> {
  const serverName = manifestName(name);
  return commonFiles(
    name,
    'hello',
    agentTargets,
    `import { annotations, server, tool, z } from '@noodleseed/one';

// The server name and title derive from your project name — if you repurpose or rename this app,
// update both (and noodle.json) so its identity stays consistent in MCP hosts.
export default server('${serverName}', { title: '${title(name)}', version: '1.0.0' }, [
  tool('greet', {
    description: 'Greet a person by name.',
    input: z.object({
      name: z.string().default('world'),
    }),
    output: z.object({
      message: z.string(),
    }),
    // Read-only, closed-world tools run without a consent prompt in assistant surfaces;
    // unannotated tools always require confirmation.
    annotations: annotations.readOnly(),
    fulfil: ({ input }) => {
      return { message: \`Hello, \${input.name}!\` };
    },
  }),
]);
`,
    [],
  );
}
export function httpApiFiles(
  name: string,
  agentTargets: readonly ProjectAgentTarget[],
): Record<string, string> {
  const serverName = manifestName(name);
  return commonFiles(
    name,
    'http-api',
    agentTargets,
    `import { annotations, connector, server, tool, variable, z } from '@noodleseed/one';

// CONTRACT SEAM: share the operation's validated input/output with the public tool.
const input = z.object({ post_id: z.string().regex(/^[0-9]{1,12}$/).default('1') }).strict();
const output = z.object({ title: z.string(), body: z.string() });
// BINDING SEAM: the operator supplies a reviewed origin, never a tool argument or browser value.
const origin = variable('POSTS_API_ORIGIN');
const posts = connector('posts')
  .version('1.0.0')
  .http({
    baseUrl: origin,
    allowedOrigins: [origin],
    operations: {
      get_post: {
        type: 'read',
        method: 'GET',
        path: '/posts/\${args.post_id}',
        input,
        response: {
          title: '\${response.title}',
          body: '\${response.body}',
        },
        output,
      },
    },
  });

export default server('${serverName}', {
  title: '${title(name)}',
  version: '1.0.0',
  use: { posts },
}, [
  tool('get_post', {
    description: 'Read one post by its validated numeric identifier.',
    annotations: annotations.readOnly(),
    input,
    output,
    fulfil: ({ input, connectors }) => {
      const post = connectors.posts.getPost({ post_id: input.post_id });
      return { title: post.title, body: post.body };
    },
  }),
]);
`,
    [],
  );
}
export function commonFiles(
  name: string,
  template: InitTemplate,
  agentTargets: readonly ProjectAgentTarget[],
  serverTs: string,
  extraDependencies: readonly string[],
): Record<string, string> {
  const model = SCAFFOLD_MODELS[template];
  const agentCheck =
    'vitest run --dir test && noodle validate --json && tsc --noEmit' +
    (model.widget ? ' && noodle check --json' : '');
  // Widget projects also get a ChatGPT-targeted readiness gate (domain, openai/* metadata, CSP shape) —
  // the ChatGPT App out-of-box promise, so an agent can exercise it explicitly.
  const agentCheckChatgpt = model.widget
    ? 'vitest run --dir test && noodle validate --json && tsc --noEmit && noodle check --target chatgpt --json'
    : undefined;
  return {
    'noodle.json': `${JSON.stringify(
      {
        entrypoint: 'src/server.ts',
        name,
        template,
        // --no-agents means "no declaration", not "explicitly none": omit the field so a later
        // `noodle agents setup` still defaults to all targets; only a hand-written `"agents": []`
        // opts a project out of generation.
        ...(agentTargets.length > 0 ? { agents: agentTargets } : {}),
      },
      null,
      2,
    )}\n`,
    'src/server.ts': serverTs,
    'package.json': `${JSON.stringify(
      {
        name,
        version: '0.1.0',
        private: true,
        type: 'module',
        scripts: {
          test: 'vitest run --dir test',
          typecheck: 'tsc --noEmit',
          validate: 'noodle validate',
          dev: 'noodle dev',
          deploy: 'noodle deploy',
          'agent:check': agentCheck,
          ...(agentCheckChatgpt ? { 'agent:check:chatgpt': agentCheckChatgpt } : {}),
          'agent:commands': 'noodle commands --json',
        },
        devDependencies: projectDependencyPins([
          '@noodleseed/one',
          'vitest',
          'typescript',
          '@types/node',
          ...extraDependencies,
        ]),
      },
      null,
      2,
    )}\n`,
    'test/server.test.ts': scaffoldBehaviorTest(model),
    'tsconfig.json': `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ESNext',
          module: 'ESNext',
          moduleResolution: 'bundler',
          lib: ['ESNext', 'DOM', 'DOM.Iterable'],
          ...(model.widget ? { jsx: 'react-jsx' } : {}),
          strict: true,
          skipLibCheck: true,
          esModuleInterop: true,
          noEmit: true,
        },
        include: ['src', 'test'],
      },
      null,
      2,
    )}\n`,
    'vitest.config.ts':
      "import { defineConfig } from 'vitest/config';\n\n// Keep generated Agent Kit example suites outside the application's test run.\nexport default defineConfig({ test: { dir: 'test', include: ['**/*.test.ts'], pool: 'forks' } });\n",
    ...(model.variables.length ? { '.env.example': scaffoldEnvironment(model) } : {}),
    '.gitignore': [
      'node_modules',
      'dist',
      '.env',
      '.env.noodle',
      '.env.*',
      '!.env.example',
      '.noodle/',
      '.yarn/',
      '',
    ].join('\n'),
    'README.md': `# ${title(name)}

## Run locally (no account, no login)

\`\`\`sh
npm run agent:check
\`\`\`

Init already installed pinned project-local tooling and ran these checks unless you selected \`--no-install\`.
For files-only or failed setup, rerun \`npx --yes @noodleseed/one@${currentCliVersion()} init .\`; modified files survive.
Use the selected package manager consistently (\`pnpm run\` / \`yarn run\` instead of \`npm run\`).
The generated tests compile the authored source, list tools, check a representative result and reject invalid
input. They copy source into temporary fixture storage, never copy customer credentials, and make no hosted
requests. Use your existing package manager consistently. A fixture pass is not a customer-integration pass.
${
  model.variables.length
    ? `
## Bind the application

The operator supplies ${model.variables.map((name) => `\`${name}\``).join(', ')}; \`.env.example\` lists names only.
Use \`noodle variables set <name> --runtime local --scope env --org local --app ${name} --env dev --from-env <name>\`
after exporting the reviewed value, or use your existing ignored \`.env\` locally. Do not put secrets in source.
For the API profile, connect the existing authorized endpoint; add delegated connector auth before private data.
`
    : ''
}
Run \`npm run dev\` for hot reload and \`npm run agent:check\` for the local suite plus validation. A bare
\`noodle test\` checks registration only; use \`--tool ${model.tool} --args '${JSON.stringify(model.input)}'\`
for an explicit read after configuring its backend. Never use a production write as a setup check.

## Deploy (requires a Noodle Seed account)

\`\`\`sh
noodle login
noodle deploy --org <org> --app ${name}
\`\`\`

\`noodle deploy\` infers and saves the target on first run. Review that target and keep private capabilities
owner-only until the real customer authentication and authorization checks pass.

If this project already uses \`.env\`, \`noodle dev\` treats matching declared \`secret("NAME")\` and
\`variable("NAME")\` keys as a read-only fallback. Scoped values in \`.env.noodle\`, written with
\`noodle secrets set\` and \`noodle variables set\`, remain authoritative. Interactive deploy can offer to
copy only missing declared names from \`.env\` to the exact hosted target; the prompt defaults to No and
never displays values. Both files are ignored by git and must not be shared.

## Agent setup

\`noodle init\` generated non-secret project-local Codex and Claude Code instructions/skills. Commit those
files with \`noodle.json\`, and refresh them after CLI upgrades with \`noodle agents setup --write\`.

Your \`src/server.ts\` is yours: it compiles to portable manifest JSON (\`noodle export manifest\`) that
you can read, diff, and keep.
`,
  };
}
