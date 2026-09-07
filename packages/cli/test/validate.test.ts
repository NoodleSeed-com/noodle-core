import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, InMemoryCatalog } from '@noodle-borg/compiler';
import { compileConnectors } from '@noodle-borg/connector-defs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readDeployInput } from '../src/deploy.js';
import { run, validate } from '../src/index.js';
import { noodlePlatformCatalog } from '../src/platform.js';

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, '..', '..', '..', 'examples');
const fixtures = join(here, 'fixtures');
const helloManifest = join(examples, 'hello', 'src', 'server.ts');
const postsConnectors = join(fixtures, 'posts', 'connectors.yaml');
const apiNinjasServer = join(fixtures, 'api-key-server.ts');
const widgetHelloServer = join(fixtures, 'raw-widget-server.ts');
const perplexityServer = join(examples, 'perplexity', 'src', 'server.ts');
const weatherServer = join(examples, 'weather', 'src', 'server.ts');
const foodOrderingServer = join(examples, 'food-ordering', 'src', 'server.ts');
const internalOpsDemoServer = join(examples, 'internal-ops-demo', 'src', 'server.ts');
const embeddedAssistantServer = join(fixtures, 'embedded-assistant', 'server.ts');
let tmp: string;

const delegatedTokenExchangeConnectors = `
connectors:
  - id: acmehr_api
    version: 1.0.0
    http:
      baseUrl: https://app.acmehr.example/api/v1
      allowedOrigins: [https://app.acmehr.example]
      auth:
        kind: delegatedTokenExchange
        tokenUrl: https://app.acmehr.example/oauth/token
        clientId: deleg-client-id
        clientSecret: ACMEHR_DELEG_CLIENT_SECRET
    operations:
      list_time_off:
        type: read
        method: GET
        path: /time-off
        output: { type: object, properties: { days: { type: number } }, additionalProperties: false }
`;

/**
 * React's client runtime inlines the public marker `React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED`
 * (and its `__CLIENT_INTERNALS_...` sibling) into built widget bundles. It is an API sentinel, not a
 * credential, so strip it before the credential-leak scans below — otherwise a built React widget
 * false-positives on `/secret/i`.
 */
const withoutReactInternals = (value: string): string =>
  value
    .replace(/__(?:SECRET|CLIENT)_INTERNALS_[A-Z_]+/g, '')
    .replace(/data-noodle-react-bundle=\\"[\s\S]*?\\"/g, 'data-noodle-react-bundle="[compiled]"')
    .replace(/data-noodle-react-bundle="[\s\S]*?"/g, 'data-noodle-react-bundle="[compiled]"');

const deployInputForSecretScan = (value: string): string => {
  try {
    const input = JSON.parse(value) as Record<string, unknown>;
    if (typeof input.manifest !== 'string') return withoutReactInternals(value);
    const manifest = JSON.parse(input.manifest) as Record<string, unknown>;
    if (Array.isArray(manifest.widgets)) {
      manifest.widgets = manifest.widgets.map((widget) => {
        if (widget === null || typeof widget !== 'object') return widget;
        const nextWidget = { ...(widget as Record<string, unknown>) };
        if (
          typeof nextWidget.html === 'string' &&
          nextWidget.html.includes('data-noodle-react-bundle')
        ) {
          nextWidget.html = '[compiled react widget]';
        }
        if (nextWidget.view !== null && typeof nextWidget.view === 'object') {
          const view = { ...(nextWidget.view as Record<string, unknown>) };
          if (
            typeof view.compiledHtml === 'string' &&
            view.compiledHtml.includes('data-noodle-react-bundle')
          ) {
            view.compiledHtml = '[compiled react widget]';
          }
          nextWidget.view = view;
        }
        return nextWidget;
      });
    }
    return withoutReactInternals(JSON.stringify({ ...input, manifest: JSON.stringify(manifest) }));
  } catch {
    return withoutReactInternals(value);
  }
};

/** Write a server whose tool maps a number to a string-typed connector argument (arg_type_mismatch). */
function writeMismatchServer(dir: string): string {
  const path = join(dir, 'mismatch.ts');
  writeFileSync(
    path,
    `
import { connector, server, tool, z } from '@noodleseed/one';

const posts = connector('jsonplaceholder').version('1.0.0').operation('get_post', {
  type: 'read',
  input: {
    type: 'object',
    properties: { post_id: { type: 'string' } },
    required: ['post_id'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: { title: { type: 'string' }, body: { type: 'string' } },
    additionalProperties: false,
  },
});

export default server('posts', { title: 'Posts', version: '1.0.0', use: { posts } }, [
  tool(
    'get_post',
    {
      description: 'Fetch a post.',
      input: z.object({ post_id: z.string() }),
      output: z.object({ title: z.string(), body: z.string() }),
      fulfil: ({ connectors }) => {
        const post = connectors.posts.getPost({ post_id: 5 });
        return { title: post.title, body: post.body };
      },
    },
  ),
]);
`,
  );
  return path;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'noodle-validate-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});
describe('validate()', () => {
  it('accepts a valid connector-free manifest', async () => {
    const outcome = await validate({ manifestPath: helloManifest });
    expect(outcome.ok).toBe(true);
  });

  /**
   * `ts.transpileModule()` is single-file and type-check-free, and it emits *error-recovered* output
   * for input that does not parse. Without diagnostics an unparseable `server.ts` therefore became
   * running JavaScript whose semantics were whatever the parser guessed — and every command reads its
   * entrypoint through this path, including `deploy`. Failing at read time is the only honest answer.
   */
  it('rejects an entrypoint that does not parse instead of transpiling it anyway', async () => {
    const broken = join(tmp, 'broken-server.ts');
    writeFileSync(
      broken,
      [
        "import { server, tool, z } from '@noodleseed/one';",
        '',
        "const greet = tool('greet', {",
        "  description: 'Say hello.',",
        '  input: z.object({}),',
        '  fulfil: () => ({ ok: true }),',
        // The closing `)` is missing: `tsc` reports TS1005, but transpileModule recovers silently.
        '};',
        '',
        "export default server('broken', { title: 'Broken', version: '1.0.0' }, [greet]);",
      ].join('\n'),
    );

    const outcome = await validate({ manifestPath: broken });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stage).toBe('read');
    expect(outcome.errors[0]?.code).toBe('read_error');
    // Actionable: name the file and the position, the way tsc would.
    expect(outcome.errors[0]?.message).toContain('broken-server.ts');
    expect(outcome.errors[0]?.message).toMatch(/\d+:\d+/);
  });

  /**
   * The parse check must key on diagnostics about the *source*. `transpileModule` also emits global
   * option diagnostics (TS5110 for this call's module/moduleResolution pairing), and treating those as
   * failures would reject every valid entrypoint in the repo.
   */
  it('ignores option-level diagnostics that say nothing about the source', async () => {
    const outcome = await validate({ manifestPath: helloManifest });
    expect(outcome.ok).toBe(true);
  });
  it('accepts curated public examples through TypeScript entrypoints', async () => {
    for (const manifestPath of [
      helloManifest,
      weatherServer,
      perplexityServer,
      foodOrderingServer,
      internalOpsDemoServer,
    ]) {
      const outcome = await validate({ manifestPath });
      expect(
        outcome.ok,
        outcome.ok ? '' : `${manifestPath}: ${JSON.stringify(outcome.errors)}`,
      ).toBe(true);
    }
  }, 15_000);
  it('accepts the Perplexity example and emits only managed secret references', async () => {
    const outcome = await validate({ manifestPath: perplexityServer });
    expect(outcome.ok, outcome.ok ? '' : JSON.stringify(outcome.errors)).toBe(true);
    const input = await readDeployInput(perplexityServer);
    expect(input.connectors).toBeDefined();
    expect(input.manifest).not.toMatch(/PERPLEXITY_API_KEY=.*|pplx-secret|pplx-token/);
    expect(input.connectors).not.toMatch(/PERPLEXITY_API_KEY=.*|pplx-secret|pplx-token/);
    const catalog = compileConnectors(input.connectors ?? '');
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;
    expect(catalog.secretBindings).toEqual([
      {
        connectorId: 'perplexity',
        connectorVersion: '1.0.0',
        secretRef: 'PERPLEXITY_API_KEY',
      },
    ]);
    const compiled = compile(input.manifest, { catalog: new InMemoryCatalog(catalog.catalog) });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.artifact.tools.map((tool) => tool.name)).toEqual([
      'search',
      'answer',
      'research',
      'start_research',
      'get_research',
      'list_research',
    ]);
    expect(
      compiled.artifact.tools.find((tool) => tool.name === 'research')?.outputSchema,
    ).toMatchObject({
      type: 'object',
      properties: {
        id: { type: 'string' },
        status: { type: 'string' },
        model: { type: 'string' },
        output: { type: 'array' },
      },
    });
    expect(
      compiled.artifact.tools.find((tool) => tool.name === 'get_research')?.outputSchema,
    ).toMatchObject({
      type: 'object',
      properties: {
        id: { type: 'string' },
        status: { type: 'string' },
        model: { type: 'string' },
        response: {},
        error_message: {},
      },
    });
  });
  it('accepts the API Ninjas apiKey TypeScript example and emits only a managed secret reference', async () => {
    const outcome = await validate({ manifestPath: apiNinjasServer });
    expect(outcome.ok).toBe(true);
    const input = await readDeployInput(apiNinjasServer);
    expect(input.connectors).toBeDefined();
    expect(input.manifest).not.toContain('YOUR_API_KEY');
    expect(input.connectors).not.toContain('YOUR_API_KEY');
    const catalog = compileConnectors(input.connectors ?? '');
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;
    expect(catalog.secretBindings).toEqual([
      {
        connectorId: 'api_ninjas',
        connectorVersion: '1.0.0',
        secretRef: 'API_NINJAS_KEY',
      },
    ]);
    const compiled = compile(input.manifest, { catalog: new InMemoryCatalog(catalog.catalog) });
    expect(compiled.ok).toBe(true);
  });
  it('resolves a relative entrypoint to an absolute rootDir (else the React widget build throws)', async () => {
    // Regression: `noodle devtools ./path/server.ts` failed with "filename must be an absolute path"
    // because readDeployInput kept rootDir relative. A relative path must still yield an absolute rootDir.
    const relPath = relative(process.cwd(), apiNinjasServer);
    expect(isAbsolute(relPath)).toBe(false);
    const input = await readDeployInput(relPath);
    expect(isAbsolute(input.rootDir)).toBe(true);
    expect(input.manifest).toBeTruthy();
  });
  it('accepts the widget hello TypeScript example and emits a standard MCP Apps resource', async () => {
    const outcome = await validate({ manifestPath: widgetHelloServer });
    expect(outcome.ok).toBe(true);
    const input = await readDeployInput(widgetHelloServer);
    expect(input.manifest).not.toMatch(
      /NOODLE_AUTH_TOKEN|oauthRefreshToken|callerKey|nbk_|SECRET|API_KEY/,
    );
    const compiled = compile(input.manifest, {
      localAssets: {
        rootDir: dirname(foodOrderingServer),
        publicOrigin: 'http://127.0.0.1:4567',
      },
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const widget = compiled.artifact.resources?.find(
      (r) => r.uri === 'ui://widget_hello/greet_widget',
    );
    expect(widget?.mimeType).toBe('text/html;profile=mcp-app');
    expect(widget?.fulfilment).toMatchObject({
      kind: 'flow',
      steps: [],
    });
    const greet = compiled.artifact.tools.find((t) => t.name === 'greet');
    expect(greet?._meta?.ui?.resourceUri).toBe('ui://widget_hello/greet_widget');
    expect(greet?.outputSchema).toMatchObject({
      type: 'object',
      properties: {
        message: { type: 'string' },
      },
    });
    const refresh = compiled.artifact.tools.find((t) => t.name === 'refresh_greeting');
    expect(refresh?._meta?.ui?.visibility).toEqual(['app']);
  });
  it('builds React view entries into hydrated widget HTML at the CLI authoring boundary', async () => {
    const views = join(tmp, 'views');
    writeFileSync(
      join(tmp, 'helpers.ts'),
      `
import type { ServerDefinition } from '@noodleseed/one';
import { generateHelpers } from '@noodleseed/one/react';

export type AppType = ServerDefinition;
export const { useToolInfo } = generateHelpers<AppType>();
`,
    );
    mkdirSync(views, { recursive: true });
    writeFileSync(
      join(views, 'GreetingCard.tsx'),
      `
import { useToolInfo } from '../helpers.js';

export default function GreetingCard() {
  const result = useToolInfo('greet').structuredContent as { message?: string } | undefined;
  return <main data-llm={result?.message ?? 'Greeting ready'}><h1>Greeting card</h1><p>{result?.message ?? 'Ready.'}</p></main>;
}
`,
    );
    const manifestPath = join(tmp, 'server.ts');
    writeFileSync(
      manifestPath,
      `
import { server, tool, z } from '@noodleseed/one';

export default server('built_widget', { title: 'Built Widget', version: '1.0.0' }, [
  tool('greet', {
    description: 'Open a built React widget.',
    input: z.object({}),
    output: z.object({ message: z.string() }),
    fulfil: () => ({ message: 'Hello from React.' }),
    viewTitle: 'Greeting card',
    view: { component: 'GreetingCard', entry: './views/GreetingCard.tsx' },
  }),
]);
`,
    );
    const input = await readDeployInput(manifestPath);
    const compiled = compile(input.manifest);
    expect(compiled.ok, compiled.ok ? '' : JSON.stringify(compiled.errors)).toBe(true);
    if (!compiled.ok) return;
    const resource = compiled.artifact.resources?.find(
      (item) => item.uri === 'ui://built_widget/greet_widget',
    );
    const html =
      (resource?.fulfilment as { output?: { value?: { value?: string } } }).output?.value?.value ??
      '';
    expect(html).toContain('data-noodle-react-bundle');
    expect(html).toContain('Greeting card');
    expect(html).not.toContain('data-noodle-react-entry="./views/GreetingCard.tsx"');
    expect(resource?._meta?.ui?.prefersBorder).toBe(false);
  });
  it('loads TypeScript entrypoints with sibling TypeScript modules imported via ESM .js specifiers', async () => {
    const helper = join(tmp, 'widget.ts');
    const views = join(tmp, 'views');
    const manifestPath = join(tmp, 'server.ts');
    mkdirSync(views, { recursive: true });
    writeFileSync(
      join(views, 'SplitGreetingWidget.tsx'),
      `
export default function SplitGreetingWidget() {
  return <main data-llm="Split greeting ready">Split greeting ready</main>;
}
`,
    );
    writeFileSync(
      helper,
      `
export const VIEW = { component: 'SplitGreetingWidget', entry: './views/SplitGreetingWidget.tsx' };
`,
    );
    writeFileSync(
      manifestPath,
      `
import { server, tool, z } from '@noodleseed/one';
import { VIEW } from './widget.js';

export default server('split_widget', { title: 'Split Widget', version: '1.0.0' }, [
  tool(
    'greet',
    {
      description: 'Greet with a widget from a sibling TypeScript module.',
      input: z.object({ name: z.string().default('world') }),
      output: z.object({ message: z.string() }),
      fulfil: ({ input }) => ({ message: \`Hello, \${input.name}!\` }),
      viewTitle: 'Greeting',
      view: VIEW,
    },
  ),
]);
`,
    );
    const input = await readDeployInput(manifestPath);
    const compiled = compile(input.manifest, {
      localAssets: {
        rootDir: dirname(foodOrderingServer),
        publicOrigin: 'http://127.0.0.1:4567',
      },
    });
    expect(compiled.ok, compiled.ok ? '' : JSON.stringify(compiled.errors)).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.artifact.resources?.[0]?.uri).toBe('ui://split_widget/greet_widget');
  });
  it('rejects YAML app inputs at the public CLI authoring boundary', async () => {
    const bad = join(tmp, 'bad.yaml');
    writeFileSync(bad, 'manifestVersion: "1"\nserver: {}\ntools: []\n');
    const outcome = await validate({ manifestPath: bad });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stage).toBe('read');
    expect(outcome.errors[0]?.message).toContain('public app authoring uses TypeScript');
  });
  it('reports unknown_operation with a didYouMean suggestion against the catalog', async () => {
    const typo = join(tmp, 'typo.ts');
    writeFileSync(
      typo,
      `
import { connector, server, tool, z } from '@noodleseed/one';

const posts = connector('jsonplaceholder').version('1.0.0').operation('get_postt', {
  type: 'read',
  input: {
    type: 'object',
    properties: { post_id: { type: 'string' } },
    required: ['post_id'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: { title: { type: 'string' }, body: { type: 'string' } },
    additionalProperties: false,
  },
});

export default server('posts', { title: 'Posts', version: '1.0.0', use: { posts } }, [
  tool(
    'get_post',
    {
      description: 'Fetch a post.',
      input: z.object({ post_id: z.string() }),
      output: z.object({ title: z.string(), body: z.string() }),
      fulfil: ({ input, connectors }) => {
        const post = connectors.posts.getPostt({ post_id: input.post_id });
        return { title: post.title, body: post.body };
      },
    },
  ),
]);
`,
    );
    const outcome = await validate({ manifestPath: typo, connectorsPath: postsConnectors });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stage).toBe('manifest');
    const unknown = outcome.errors.find((e) => e.code === 'unknown_operation');
    expect(unknown).toBeDefined();
    expect(unknown?.didYouMean).toBe('get_post');
  });
  it('surfaces structured expected/got/docAnchor on a connector argument type mismatch', async () => {
    const mismatch = join(tmp, 'mismatch.ts');
    writeFileSync(
      mismatch,
      `
import { connector, server, tool, z } from '@noodleseed/one';

const posts = connector('jsonplaceholder').version('1.0.0').operation('get_post', {
  type: 'read',
  input: {
    type: 'object',
    properties: { post_id: { type: 'string' } },
    required: ['post_id'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: { title: { type: 'string' }, body: { type: 'string' } },
    additionalProperties: false,
  },
});

export default server('posts', { title: 'Posts', version: '1.0.0', use: { posts } }, [
  tool(
    'get_post',
    {
      description: 'Fetch a post.',
      input: z.object({ post_id: z.string() }),
      output: z.object({ title: z.string(), body: z.string() }),
      fulfil: ({ connectors }) => {
        const post = connectors.posts.getPost({ post_id: 5 });
        return { title: post.title, body: post.body };
      },
    },
  ),
]);
`,
    );
    const outcome = await validate({ manifestPath: mismatch, connectorsPath: postsConnectors });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const mismatchError = outcome.errors.find((e) => e.code === 'arg_type_mismatch');
    expect(mismatchError).toMatchObject({
      expected: 'string',
      got: 'number',
      docAnchor: 'compile-errors#arg-type-mismatch',
    });
  });
  it('reports connector-catalog compile errors at the connectors stage', async () => {
    const badConnectors = join(tmp, 'connectors.yaml');
    writeFileSync(badConnectors, 'connectors:\n  - id: x\n'); // missing version/kind/http
    const outcome = await validate({
      manifestPath: helloManifest,
      connectorsPath: badConnectors,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stage).toBe('connectors');
  });
  it('rejects delegated exchange without a customer identity source', async () => {
    const connectorsPath = join(tmp, 'connectors.yaml');
    const manifestPath = join(tmp, 'server.ts');
    writeFileSync(connectorsPath, delegatedTokenExchangeConnectors);
    writeFileSync(
      manifestPath,
      `
import { server, tool, z } from '@noodleseed/one';
export default server('no_identity', { title: 'No Identity', version: '1.0.0' }, [
  tool('ping', { description: 'Return readiness.', input: z.object({}), fulfil: () => ({ ok: true }) })
]);
`,
    );

    const outcome = await validate({ manifestPath, connectorsPath });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stage).toBe('manifest');
    expect(outcome.errors).toContainEqual({
      code: 'delegated_token_exchange_identity_required',
      path: 'server.auth',
      message:
        'delegatedTokenExchange on acmehr_api.* requires a verified customer identity source; declare server.auth with customerAuth(...) or server.assistant with embeddedAssistant(...)',
    });
  });
  it('accepts delegated exchange when an embedded assistant supplies customer identity', async () => {
    const connectorsPath = join(tmp, 'connectors.yaml');
    writeFileSync(connectorsPath, delegatedTokenExchangeConnectors);

    const outcome = await validate({ manifestPath: embeddedAssistantServer, connectorsPath });

    expect(outcome.ok, outcome.ok ? '' : JSON.stringify(outcome.errors)).toBe(true);
  });
  it('reports a read error for a missing manifest', async () => {
    const outcome = await validate({ manifestPath: join(tmp, 'nope.yaml') });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stage).toBe('read');
  });
  it('accepts the food ordering widget example with app-only helpers and React views', async () => {
    const outcome = await validate({ manifestPath: foodOrderingServer });
    expect(outcome.ok, outcome.ok ? '' : JSON.stringify(outcome.errors)).toBe(true);
    const input = await readDeployInput(foodOrderingServer);
    expect(input.manifest).toBeDefined();
    const catalog = input.connectors ? compileConnectors(input.connectors).catalog : [];
    const compiled = compile(input.manifest, {
      catalog: new InMemoryCatalog([...noodlePlatformCatalog, ...catalog]),
      localAssets: {
        rootDir: dirname(foodOrderingServer),
        publicOrigin: 'http://127.0.0.1:4567',
      },
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const widget = compiled.artifact.resources?.find(
      (r) => r.uri === 'ui://food_ordering/open_ordering_widget',
    );
    const html = (
      widget?.fulfilment as {
        output?: {
          value?: {
            value?: string;
          };
        };
      }
    ).output?.value?.value;
    const manifest = JSON.parse(input.manifest);
    expect(manifest.server.branding?.logo?.uri).toMatchObject({
      kind: 'asset',
      sourcePath: 'assets/noodle-bowl.jpg',
    });
    expect(compiled.localAssets).toHaveLength(1);
    expect(compiled.artifact.assets?.map((asset) => asset.sourcePath)).toEqual([
      'assets/noodle-bowl.jpg',
    ]);
    expect(compiled.artifact.server.branding).toMatchObject({
      name: 'Food Ordering',
      accent: '#0F8F5F',
      surface: '#F7F7F5',
      surfaceDark: '#111820',
      logo: {
        alt: 'Food Ordering noodle bowl',
      },
    });
    expect(compiled.artifact.server.branding?.logo?.uri).toMatch(
      /^http:\/\/127\.0\.0\.1:4567\/__noodle\/assets\//,
    );
    expect(compiled.artifact.server.handoff).toEqual({
      allowedDomains: ['https://orders.example.com'],
    });
    expect(widget?.mimeType).toBe('text/html;profile=mcp-app');
    expect(html).toContain('id="noodle-react-root"');
    expect(html).toContain('data-noodle-react-view="ordering-flow"');
    expect(html).toContain('data-noodle-react-bundle');
    expect(html).not.toContain('data-noodle-react-entry="./views/ordering-flow.tsx"');
    expect(html).toContain('data-noodle-policy');
    expect(html).toContain('"allowedDomains":["https://orders.example.com"]');
    expect(
      compiled.artifact.tools.find((t) => t.name === 'sync_cart')?._meta?.ui?.visibility,
    ).toEqual(['app']);
    expect(
      compiled.artifact.tools.find((t) => t.name === 'prepare_checkout')?._meta?.ui?.visibility,
    ).toEqual(['app']);
    expect(deployInputForSecretScan(JSON.stringify(input))).not.toMatch(
      /caller-key|api[_-]?key|secret|token/i,
    );
  });
  it('accepts the regular-MCP internal operations demo with resources, prompts, and no widget resources', async () => {
    const outcome = await validate({ manifestPath: internalOpsDemoServer });
    expect(outcome.ok, outcome.ok ? '' : JSON.stringify(outcome.errors)).toBe(true);
    const input = await readDeployInput(internalOpsDemoServer);
    expect(input.connectors).toBeUndefined();
    expect(JSON.stringify(input)).not.toMatch(
      /NOODLE_AUTH_TOKEN|oauthRefreshToken|callerKey|nbk_|US-SECRET-ROUTING|ACCT-999999|ACCT-888888/i,
    );
    const compiled = compile(input.manifest);
    expect(compiled.ok, compiled.ok ? '' : JSON.stringify(compiled.errors)).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.artifact.server).toMatchObject({
      name: 'internal_ops_demo',
      title: 'Internal Operations Demo',
    });
    expect(compiled.artifact.resources?.map((resource) => resource.uri)).toEqual(
      expect.arrayContaining([
        'policy://internal-ops-demo',
        'employee://{employee_id}',
        'case://{case_id}',
      ]),
    );
    expect(compiled.artifact.resources ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ mimeType: 'text/html;profile=mcp-app' })]),
    );
    expect(compiled.artifact.prompts?.map((prompt) => prompt.name)).toEqual(
      expect.arrayContaining(['customer_safe_incident_update', 'invoice_approval_brief']),
    );
    expect(compiled.artifact.tools.map((toolDef) => toolDef.name)).toEqual(
      expect.arrayContaining([
        'lookup_employee',
        'search_cases',
        'get_case_detail',
        'draft_customer_reply',
        'lookup_invoice',
        'check_approval_policy',
        'prepare_approval_packet',
        'approve_invoice',
      ]),
    );
    expect(
      compiled.artifact.tools.every((toolDef) => toolDef._meta?.ui?.visibility?.[0] !== 'app'),
    ).toBe(true);
  });
  it('accepts the rich food ordering widget flagship', async () => {
    const outcome = await validate({ manifestPath: foodOrderingServer });
    expect(outcome.ok, outcome.ok ? '' : JSON.stringify(outcome.errors)).toBe(true);
    const input = await readDeployInput(foodOrderingServer);
    expect(deployInputForSecretScan(JSON.stringify(input))).not.toMatch(
      /NOODLE_AUTH_TOKEN|oauthRefreshToken|callerKey|nbk_|api[_-]?key|secret/i,
    );
    const connectors = input.connectors ? compileConnectors(input.connectors).catalog : [];
    const compiled = compile(input.manifest, {
      catalog: new InMemoryCatalog([...noodlePlatformCatalog, ...connectors]),
      localAssets: {
        rootDir: dirname(foodOrderingServer),
        publicOrigin: 'http://127.0.0.1:4567',
      },
    });
    expect(compiled.ok, compiled.ok ? '' : JSON.stringify(compiled.errors)).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.artifact.server).toMatchObject({
      name: 'food_ordering',
      title: 'Food Ordering',
      branding: {
        name: 'Food Ordering',
        accent: '#0F8F5F',
        surface: '#F7F7F5',
        surfaceDark: '#111820',
        radius: 'lg',
        density: 'comfortable',
      },
      handoff: {
        allowedDomains: ['https://orders.example.com'],
      },
    });
    expect(compiled.artifact.server.state?.handles?.cart).toMatchObject({
      kind: 'cart',
      scope: 'caller',
    });
    for (const helper of [
      'search_stores',
      'load_menu',
      'load_item',
      'read_cart',
      'sync_cart',
      'prepare_checkout',
    ]) {
      expect(
        compiled.artifact.tools.find((toolDef) => toolDef.name === helper)?._meta?.ui?.visibility,
      ).toEqual(['app']);
    }
    const openOrdering = compiled.artifact.tools.find(
      (toolDef) => toolDef.name === 'open_ordering',
    );
    const widget = compiled.artifact.resources?.find(
      (resource) => resource.uri === 'ui://food_ordering/open_ordering_widget',
    );
    const standaloneWidget = compiled.artifact.resources?.find(
      (resource) => resource.uri === 'ui://food_ordering/capabilities_card',
    );
    const html = (
      widget?.fulfilment as {
        output?: {
          value?: {
            value?: string;
          };
        };
      }
    ).output?.value?.value;
    const lowerHtml = html?.toLowerCase() ?? '';
    expect(openOrdering?._meta?.ui?.resourceUri).toBe('ui://food_ordering/open_ordering_widget');
    expect(widget?.mimeType).toBe('text/html;profile=mcp-app');
    expect(standaloneWidget?.mimeType).toBe('text/html;profile=mcp-app');
    expect(standaloneWidget?._meta?.ui?.permissions).toMatchObject({ clipboardWrite: {} });
    expect(standaloneWidget?._meta?.ui?.csp?.connectDomains).toEqual([
      'https://orders.example.com',
    ]);
    expect(standaloneWidget?._meta?.ui?.csp?.resourceDomains).toEqual(
      expect.arrayContaining(['https://orders.example.com', 'http://127.0.0.1:4567']),
    );
    expect(standaloneWidget?._meta?.ui?.csp?.frameDomains).toEqual(['https://orders.example.com']);
    expect(lowerHtml).toContain('id="noodle-react-root"');
    expect(html).toContain('data-noodle-react-view="ordering-flow"');
    expect(html).toContain('data-noodle-react-bundle');
    expect(html).not.toContain('data-noodle-react-entry="./views/ordering-flow.tsx"');
    expect(html).toContain('data-noodle-policy');
  });
});
describe('run(["validate", ...])', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });
  it('exit 0 for a valid manifest', async () => {
    expect(await run(['validate', helloManifest])).toBe(0);
  });
  it('exit 1 for an invalid manifest and prints the error', async () => {
    const bad = join(tmp, 'bad.yaml');
    writeFileSync(bad, 'manifestVersion: "9.9"\nserver: {}\ntools: []\n');
    expect(await run(['validate', bad])).toBe(1);
    expect(errSpy.mock.calls.length).toBeGreaterThan(0);
  });
  it('exit 2 when no manifest path is given', async () => {
    const cwd = process.cwd();
    process.chdir(tmp);
    try {
      expect(await run(['validate'])).toBe(2);
    } finally {
      process.chdir(cwd);
    }
  });
  it('--json on a valid manifest prints {ok:true} to stdout and exits 0', async () => {
    expect(await run(['validate', helloManifest, '--json'])).toBe(0);
    const printed = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string);
    expect(printed.ok).toBe(true);
    expect(errSpy.mock.calls.length).toBe(0);
  });
  it('--json on an invalid manifest prints the enriched error shape and exits 1', async () => {
    const mismatch = writeMismatchServer(tmp);
    expect(await run(['validate', mismatch, '--connectors', postsConnectors, '--json'])).toBe(1);
    const printed = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string);
    expect(printed.ok).toBe(false);
    expect(printed.error.code).toBe('validation_failed');
    const mismatchError = printed.error.errors.find(
      (e: { code: string }) => e.code === 'arg_type_mismatch',
    );
    expect(mismatchError).toMatchObject({
      expected: 'string',
      got: 'number',
      docAnchor: 'compile-errors#arg-type-mismatch',
    });
  });
  it('human output prints expected/got lines for an enriched error', async () => {
    const mismatch = writeMismatchServer(tmp);
    expect(await run(['validate', mismatch, '--connectors', postsConnectors])).toBe(1);
    const printed = errSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).toContain('expected: string');
    expect(printed).toContain('got: number');
  });
  it('--fix-prompt includes the enriched fields for the agent repair loop', async () => {
    const mismatch = writeMismatchServer(tmp);
    expect(await run(['validate', mismatch, '--connectors', postsConnectors, '--fix-prompt'])).toBe(
      1,
    );
    const printed = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).toContain('expected: string');
    expect(printed).toContain('got: number');
    expect(printed).toContain('compile-errors#arg-type-mismatch');
  });

  // Back-compat: `--agent-output` stays an accepted alias for validate's canonical `--fix-prompt`
  // (S4 keeps both spellings parsed even though only `--fix-prompt` is advertised).
  it('--agent-output is an accepted alias for --fix-prompt (emits the repair prompt)', async () => {
    const mismatch = writeMismatchServer(tmp);
    expect(
      await run(['validate', mismatch, '--connectors', postsConnectors, '--agent-output']),
    ).toBe(1);
    const printed = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).toContain('Fix this Noodle validation failure from `validate`.');
    expect(printed).toContain('expected: string');
    expect(printed).toContain('got: number');
  });
});

describe('validate() identity coherence', () => {
  const pingServer = (name: string, title: string): string =>
    `import { server, tool, z } from '@noodleseed/one';\n` +
    `export default server('${name}', { title: '${title}', version: '1.0.0' }, [\n` +
    `  tool('ping', { description: 'ping', input: z.object({}), output: z.object({ ok: z.boolean() }), fulfil: () => ({ ok: true }) }),\n` +
    `]);\n`;

  it('warns when the server name diverges from the noodle.json project name', async () => {
    writeFileSync(join(tmp, 'noodle.json'), JSON.stringify({ name: 'vectara-demo' }));
    const manifestPath = join(tmp, 'server.ts');
    // Reused scaffold: project still 'vectara-demo' but the server was renamed to a Todoist app.
    writeFileSync(manifestPath, pingServer('todoist_tasks', 'Todoist'));
    const outcome = await validate({ manifestPath });
    expect(outcome.ok).toBe(true);
    expect(
      outcome.ok && (outcome.warnings ?? []).some((w) => w.includes('identity is inconsistent')),
    ).toBe(true);
  });

  it('does not warn when server name and project name agree after kebab/snake normalization', async () => {
    writeFileSync(join(tmp, 'noodle.json'), JSON.stringify({ name: 'vectara-demo' }));
    const manifestPath = join(tmp, 'server.ts');
    // `noodle init` derives the snake-case server name from the kebab project name — not a mismatch.
    writeFileSync(manifestPath, pingServer('vectara_demo', 'Vectara Demo'));
    const outcome = await validate({ manifestPath });
    expect(outcome.ok).toBe(true);
    expect(
      outcome.ok && (outcome.warnings ?? []).some((w) => w.includes('identity is inconsistent')),
    ).toBe(false);
  });

  it('does not warn when there is no noodle.json (a bare entrypoint)', async () => {
    const manifestPath = join(tmp, 'server.ts');
    writeFileSync(manifestPath, pingServer('todoist_tasks', 'Todoist'));
    const outcome = await validate({ manifestPath });
    expect(outcome.ok).toBe(true);
    expect(
      outcome.ok && (outcome.warnings ?? []).some((w) => w.includes('identity is inconsistent')),
    ).toBe(false);
  });
});
