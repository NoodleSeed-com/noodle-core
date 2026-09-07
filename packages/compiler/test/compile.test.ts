import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { compile } from '../src/compile.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'fixtures');

function read(rel: string): string {
  return readFileSync(join(fixtures, rel), 'utf8');
}

describe('compile (valid manifest)', () => {
  it('compiles the minimal manifest to the golden artifact', () => {
    const result = compile(read('valid/minimal.manifest.yaml'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const golden = JSON.parse(read('valid/minimal.artifact.json'));
    expect(result.artifact).toEqual(golden);
  });

  it('is deterministic: identical input yields byte-identical output', () => {
    const src = read('valid/minimal.manifest.yaml');
    const a = compile(src);
    const b = compile(src);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(JSON.stringify(a.artifact)).toBe(JSON.stringify(b.artifact));
  });

  it('marks the artifact shape-only with unresolved operation refs', () => {
    const result = compile(read('valid/minimal.manifest.yaml'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.resolution).toBe('shape-only');
    const fulfilment = result.artifact.tools[0]?.fulfilment;
    expect(fulfilment?.kind).toBe('operation');
    if (fulfilment?.kind === 'operation') {
      expect(fulfilment.operationRef).toEqual({
        connector: 'acme',
        operation: 'get_order',
        resolved: false,
      });
    }
  });

  it('advertises the JSON Schema 2020-12 dialect on emitted tool input schemas', () => {
    const result = compile(read('valid/minimal.manifest.yaml'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.tools[0]?.inputSchema.$schema).toBe(
      'https://json-schema.org/draft/2020-12/schema',
    );
  });

  it('carries tool annotations into the runtime artifact', () => {
    const result = compile(`
manifestVersion: "1"
server:
  name: annotated
  version: 1.0.0
  title: Annotated
tools:
  - name: lookup
    description: Use this when reading something.
    annotations:
      readOnlyHint: true
      destructiveHint: false
      idempotentHint: true
      openWorldHint: false
    inputSchema:
      type: object
    fulfilment:
      steps: []
      output:
        ok: true
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.tools[0]?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it('carries the server interaction fallback into the runtime artifact', () => {
    const result = compile(`
manifestVersion: "1"
server:
  name: host_confirmed
  version: 1.0.0
  title: Host Confirmed
  interactions:
    confirmationFallback: host
tools:
  - name: submit
    description: Submit something.
    inputSchema:
      type: object
    fulfilment:
      steps: []
      output:
        ok: true
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.server.interactions).toEqual({ confirmationFallback: 'host' });
  });

  it('carries embedded assistant configuration into the runtime artifact without secret values', () => {
    const result = compile(`
manifestVersion: "1"
server:
  name: embedded
  version: 1.0.0
  title: Embedded
  branding:
    name: Example Assistant
    accent: '#5B4CF0'
    surface: '#FFFFFF'
    surfaceDark: '#15131A'
    theme:
      light: { text: '#15131A' }
      dark: { accent: '#A99FFF', text: '#FFFFFF' }
  assistant:
    model:
      kind: openai-compatible
      transport: responses
      baseUrl: \${env.ASSISTANT_MODEL_BASE_URL}
      model: \${env.ASSISTANT_MODEL}
      apiKey: ASSISTANT_MODEL_API_KEY
    allowedOrigins:
      - https://app.example.com
    layout:
      mode: floating
      position: bottom-right
      panelWidth: 420
tools:
  - name: lookup
    description: Read something.
    inputSchema:
      type: object
    fulfilment:
      steps: []
      output:
        ok: true
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.server.assistant).toEqual({
      model: {
        kind: 'openai-compatible',
        transport: 'responses',
        baseUrl: '${env.ASSISTANT_MODEL_BASE_URL}',
        model: '${env.ASSISTANT_MODEL}',
        apiKey: 'ASSISTANT_MODEL_API_KEY',
      },
      allowedOrigins: ['https://app.example.com'],
      layout: { mode: 'floating', position: 'bottom-right', panelWidth: 420 },
    });
    expect(result.artifact.server.branding).toMatchObject({
      name: 'Example Assistant',
      theme: { dark: { accent: '#A99FFF', text: '#FFFFFF' } },
    });
  });

  // HTTP is allowed only for loopback development origins, mirroring the connector/CSP
  // host-pattern loopback exception; every other origin stays https-only (roadmap S4).
  it.each([
    'https://app.example.com',
    'https://app.example.com:8443',
  ])('accepts the canonical HTTPS origin %s', (origin) => {
    const result = compile(assistantOriginManifest(origin));
    expect(result.ok).toBe(true);
  });

  it('compiles the provider-neutral Noodle-managed assistant model without provider configuration', () => {
    const result = compile(`
manifestVersion: "2"
server:
  name: managed_assistant
  version: 1.0.0
  title: Managed Assistant
  assistant:
    model: { kind: noodle-managed }
    allowedOrigins: [https://www.example.com]
    surfaces:
      - mode: public
        origins: [https://www.example.com]
        capabilities: []
tools:
  - name: answer
    description: Answer a question.
    inputSchema: { type: object }
    fulfilment: { steps: [], output: { ok: true } }
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.server.assistant?.model).toEqual({ kind: 'noodle-managed' });

    const providerLeak = compile(`
manifestVersion: "2"
server:
  name: managed_assistant
  version: 1.0.0
  title: Managed Assistant
  assistant:
    model: { kind: noodle-managed, model: qwen, apiKey: KEY }
    allowedOrigins: [https://www.example.com]
tools:
  - name: answer
    description: Answer a question.
    inputSchema: { type: object }
    fulfilment: { steps: [], output: { ok: true } }
`);
    expect(providerLeak.ok).toBe(false);
  });

  it.each([
    'http://localhost:3000',
    'http://127.0.0.1:4002',
    'http://[::1]:8080',
    'http://localhost',
  ])('accepts the loopback development origin %s', (origin) => {
    const result = compile(assistantOriginManifest(origin));
    expect(result.ok).toBe(true);
  });

  it.each([
    'http://app.example.com',
    'http://localhost.evil.example',
    'http://192.168.1.10:3000',
  ])('rejects the non-loopback HTTP origin %s', (origin) => {
    const result = compile(assistantOriginManifest(origin));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: 'server.assistant.allowedOrigins.0',
        message: expect.stringMatching(/https/i),
      }),
    );
  });

  it.each([
    'https://app.example.com/path',
    'https://app.example.com?mode=embed',
    'https://app.example.com#assistant',
    'https://user:password@app.example.com',
    'https://app.example.com/',
    'http://localhost:3000/',
    'https://APP.EXAMPLE.COM',
    'https://app.example.com:443',
    'http://localhost:80',
  ])('rejects the non-canonical assistant origin %s', (origin) => {
    const result = compile(assistantOriginManifest(origin));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: 'server.assistant.allowedOrigins.0',
        message: expect.stringMatching(/canonical bare origin/i),
      }),
    );
  });

  it('accepts a declared sessionClaims allowlist and rejects malformed claim keys', () => {
    const manifest = (claims: string) => `
manifestVersion: "1"
server:
  name: embedded
  version: 1.0.0
  title: Embedded
  assistant:
    model: { kind: openai-compatible, baseUrl: https://models.example/v1, model: example, apiKey: KEY }
    allowedOrigins: ['https://app.example.com']
    sessionClaims:
${claims}
tools:
  - name: health
    description: Read health.
    inputSchema: { type: object }
    fulfilment: { steps: [], output: { ok: true } }
`;
    const ok = compile(manifest('      displayName: { exposeToModel: true }\n      region: {}'));
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.artifact.server.assistant?.sessionClaims).toEqual({
        displayName: { exposeToModel: true },
        region: {},
      });
    }
    const badKey = compile(manifest("      'bad key!': { exposeToModel: true }"));
    expect(badKey.ok).toBe(false);
    const badShape = compile(manifest('      displayName: { sendToModel: true }'));
    expect(badShape.ok).toBe(false);
  });

  function assistantOriginManifest(origin: string): string {
    return `
manifestVersion: "1"
server:
  name: embedded
  version: 1.0.0
  title: Embedded
  assistant:
    model: { kind: openai-compatible, baseUrl: https://models.example/v1, model: example, apiKey: KEY }
    allowedOrigins: ['${origin}']
tools:
  - name: health
    description: Read health.
    inputSchema: { type: object }
    fulfilment: { steps: [], output: { ok: true } }
`;
  }

  it('rejects the removed assistant-level appearance block', () => {
    const result = compile(`
manifestVersion: "1"
server:
  name: embedded
  version: 1.0.0
  title: Embedded
  assistant:
    model: { kind: openai-compatible, baseUrl: https://models.example/v1, model: example, apiKey: KEY }
    allowedOrigins: [https://app.example.com]
    appearance: { brand: { name: Duplicate Brand } }
tools:
  - name: health
    description: Read health.
    inputSchema: { type: object }
    fulfilment: { steps: [], output: { ok: true } }
`);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors.some((error) => error.path.includes('assistant'))).toBe(true);
  });

  it('warns when explicit brand theme pairs have low contrast', () => {
    const result = compile(`
manifestVersion: "1"
server:
  name: branded
  version: 1.0.0
  title: Branded
  branding:
    theme:
      light: { surface: '#FFFFFF', text: '#FAFAFA' }
tools:
  - name: health
    description: Read health.
    inputSchema: { type: object }
    fulfilment: { steps: [], output: { ok: true } }
`);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.warnings.some((warning) => warning.code === 'branding_low_contrast')).toBe(
        true,
      );
  });

  it('normalizes typed state handle declarations into the runtime artifact', () => {
    const result = compile(`
manifestVersion: "1"
server:
  name: stateful
  version: 1.0.0
  title: Stateful
state:
  handles:
    draft:
      kind: draft
      version: v1
      scope: caller
      ttlSeconds: 3600
      claimOnAuthentication: true
      schema:
        type: object
        properties:
          title:
            type: string
        required: [title]
tools:
  - name: load
    description: Load state.
    inputSchema:
      type: object
    fulfilment:
      steps: []
      output:
        ok: true
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.server.state).toEqual({
      handles: {
        draft: {
          kind: 'draft',
          version: 'v1',
          scope: 'caller',
          ttlSeconds: 3600,
          claimOnAuthentication: true,
          schema: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: { title: { type: 'string' } },
            required: ['title'],
          },
        },
      },
    });
  });

  it.each([
    ['an explicit caller scope', `      ttlSeconds: 3600\n      claimOnAuthentication: true`],
    ['a finite ttl', `      scope: caller\n      claimOnAuthentication: true`],
  ])('rejects authentication-claimable state without %s', (_reason, declaration) => {
    const result = compile(`
manifestVersion: "1"
server:
  name: unsafe_claim
  version: 1.0.0
  title: Unsafe claim
state:
  handles:
    draft:
      kind: draft
      version: v1
${declaration}
      schema:
        type: object
tools:
  - name: load
    description: Load state.
    inputSchema: { type: object }
    fulfilment: { steps: [], output: { ok: true } }
`);
    expect(result.ok).toBe(false);
  });

  it('rejects credential-shaped fields in state handle schemas', () => {
    const result = compile(`
manifestVersion: "1"
server:
  name: unsafe_state
  version: 1.0.0
  title: Unsafe State
state:
  handles:
    session:
      kind: session
      version: v1
      schema:
        type: object
        properties:
          apiKey:
            type: string
tools:
  - name: load
    description: Load state.
    inputSchema:
      type: object
    fulfilment:
      steps: []
      output:
        ok: true
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'state_secret_field',
        path: 'state.handles.session.schema.properties.apiKey',
      }),
    );
  });

  it('handles syntax-level YAML parse errors gracefully', () => {
    const result = compile('server:\n  name: : : invalid yaml');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe('yaml_parse_error');
    expect(result.errors[0]?.message).toContain('line');
  });

  it('compiles a JSON source to the same artifact as its YAML equivalent', () => {
    const yamlSource = read('valid/minimal.manifest.yaml');
    const yamlResult = compile(yamlSource);
    expect(yamlResult.ok).toBe(true);
    if (!yamlResult.ok) return;
    const jsonResult = compile(JSON.stringify(parseYaml(yamlSource)));
    expect(jsonResult.ok).toBe(true);
    if (!jsonResult.ok) return;
    expect(jsonResult.artifact).toEqual(yamlResult.artifact);
  });

  it('parses JSON sources with JSON semantics (a duplicate key is last-wins, not a YAML error)', () => {
    // Deploys send the CLI's JSON manifests through compile(); JSON documents must take the
    // JSON.parse path (the YAML parser's transient memory on multi-megabyte JSON OOM-killed a
    // 512MiB production instance), and JSON semantics allow duplicate keys as last-wins.
    const yamlSource = read('valid/minimal.manifest.yaml');
    const json = JSON.stringify(parseYaml(yamlSource)).replace(
      '"manifestVersion":"1"',
      '"manifestVersion":"1","manifestVersion":"1"',
    );
    expect(json).toContain('"manifestVersion":"1","manifestVersion":"1"');
    const result = compile(json);
    expect(result.ok).toBe(true);
  });

  it('collects multiple different errors from across the manifest simultaneously', () => {
    const src = `
manifestVersion: "1"
server:
  name: acme_support
  version: 1.0.0
  title: Title
tools:
  - name: tool_one
    description: One
    inputSchema:
      properties:
        x:
          $use: unknown_schema
    fulfilment:
      use: acme.get_order
      args:
        id: \${steps.unknown.id}
  - name: tool_one
    description: Two
    inputSchema: {}
    fulfilment:
      use: acme.get_order
    `;
    const result = compile(src);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.errors.map((e) => e.code);
    expect(codes).toContain('unknown_schema_ref');
    expect(codes).toContain('unknown_step_ref');
    expect(codes).toContain('duplicate_name');
  });
});
