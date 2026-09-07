import {
  type CatalogConnector,
  compile,
  computeSignatureHash,
  InMemoryCatalog,
} from '@noodle-borg/compiler';
import {
  type CredentialBroker,
  type ExecuteDeps,
  executeTool,
  InMemoryConnector,
  InMemoryConnectorRegistry,
  type PolicyGate,
  StaticServiceBroker,
} from '@noodle-borg/runtime';
import { describe, expect, it } from 'vitest';
import { compileConnectors } from '../src/index.js';

const credential = { token: '' };

/** A compute connector whose `slugify` op does work the `${...}` value language cannot (regex + loops). */
function slugCatalog(): string {
  return `
connectors:
  - id: text
    version: 1.0.0
    operations:
      slugify:
        type: read
        input:
          type: object
          properties:
            title: { type: string }
          required: [title]
          additionalProperties: false
        output:
          type: object
          properties:
            slug: { type: string }
          additionalProperties: false
        code: |
          (input) => {
            let s = String(input.title).toLowerCase().replace(/[^a-z0-9]+/g, '-');
            while (s.startsWith('-')) s = s.slice(1);
            while (s.endsWith('-')) s = s.slice(0, -1);
            return { slug: s };
          }
`;
}

describe('compileConnectors — compute connectors', () => {
  it('compiles a code connector to a runnable CodeConnector', async () => {
    const result = compileConnectors(slugCatalog());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const out = await result.connectors[0]?.invoke({
      operation: 'slugify',
      args: { title: 'Hello, World! 2026' },
      credential,
    });
    expect(out).toEqual({ slug: 'hello-world-2026' });
  });

  it('emits catalog signatures that match what the code connector reports (signature-hash parity)', () => {
    const result = compileConnectors(slugCatalog());
    if (!result.ok) throw new Error('expected ok');
    const cat = result.catalog[0] as CatalogConnector;
    const catSig = cat.operations.slugify;
    const connectorSig = result.connectors[0]?.signature('slugify');
    if (!catSig || !connectorSig) throw new Error('expected a signature');
    expect(connectorSig).toEqual(catSig);
    expect(computeSignatureHash('slugify', connectorSig)).toBe(
      computeSignatureHash('slugify', catSig),
    );
  });

  it('compiles a mixed http + compute catalog (both kinds resolve)', () => {
    const result = compileConnectors(`
connectors:
  - id: api
    version: 1.0.0
    http:
      baseUrl: https://example.test
    operations:
      ping:
        type: read
        method: GET
        path: /ping
        output:
          type: object
          properties:
            ok: { type: string }
          additionalProperties: false
  - id: text
    version: 1.0.0
    operations:
      shout:
        type: read
        input:
          type: object
          properties:
            s: { type: string }
          required: [s]
          additionalProperties: false
        output:
          type: object
          properties:
            loud: { type: string }
          additionalProperties: false
        code: "(input) => ({ loud: String(input.s).toUpperCase() })"
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.connectors).toHaveLength(2);
    expect(result.connectors[0]?.signature('ping')).toBeDefined();
    expect(result.connectors[1]?.signature('shout')).toBeDefined();
  });

  it('rejects a compute operation missing its code body', () => {
    const result = compileConnectors(`
connectors:
  - id: text
    version: 1.0.0
    operations:
      bad:
        type: read
        output:
          type: object
          properties:
            v: { type: string }
          additionalProperties: false
`);
    expect(result.ok).toBe(false);
  });

  it('rejects an http transport field on a compute operation', () => {
    // `path` is an HTTP concern; a strict compute op must not carry it.
    const result = compileConnectors(`
connectors:
  - id: text
    version: 1.0.0
    operations:
      bad:
        type: read
        path: /x
        code: "(input) => input"
`);
    expect(result.ok).toBe(false);
  });

  it('rejects a compute host call to an unknown operation', () => {
    const result = compileConnectors(`
connectors:
  - id: text
    version: 1.0.0
    operations:
      wrap:
        type: read
        code: "() => callOperation('missing', {})"
        calls:
          missing: text.nope
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'unknown_call_operation')).toBe(true);
    }
  });

  it('rejects an invalid compute host-call local name', () => {
    const result = compileConnectors(`
connectors:
  - id: text
    version: 1.0.0
    operations:
      shout:
        type: read
        code: "(input) => input"
      wrap:
        type: read
        code: "() => callOperation('BadName', {})"
        calls:
          BadName: text.shout
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'invalid_call_name')).toBe(true);
    }
  });

  it('rejects a compute host-call target with an invalid reference shape', () => {
    const result = compileConnectors(`
connectors:
  - id: text
    version: 1.0.0
    operations:
      wrap:
        type: read
        code: "() => callOperation('bad', {})"
        calls:
          bad: text.shout.extra
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'invalid_call_target')).toBe(true);
    }
  });

  it('rejects a compute host call to an unknown connector', () => {
    const result = compileConnectors(`
connectors:
  - id: text
    version: 1.0.0
    operations:
      wrap:
        type: read
        code: "() => callOperation('missing', {})"
        calls:
          missing: other.shout
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'unknown_call_connector')).toBe(true);
    }
  });

  it('rejects duplicate connector ids because compute call targets would be ambiguous', () => {
    const result = compileConnectors(`
connectors:
  - id: text
    version: 1.0.0
    operations:
      shout:
        type: read
        code: "(input) => input"
  - id: text
    version: 2.0.0
    operations:
      shout:
        type: read
        code: "(input) => input"
  - id: wrapper
    version: 1.0.0
    operations:
      wrap:
        type: read
        code: "() => callOperation('shout', {})"
        calls:
          shout: text.shout
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'duplicate_connector_id')).toBe(true);
      expect(result.errors.some((e) => e.code === 'ambiguous_call_connector')).toBe(true);
    }
  });

  it('rejects a direct compute host-call cycle', () => {
    const result = compileConnectors(`
connectors:
  - id: text
    version: 1.0.0
    operations:
      loop:
        type: read
        code: "() => callOperation('self', {})"
        calls:
          self: text.loop
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'circular_call_dependency')).toBe(true);
    }
  });

  it('rejects a multi-operation compute host-call cycle', () => {
    const result = compileConnectors(`
connectors:
  - id: first
    version: 1.0.0
    operations:
      a:
        type: read
        code: "() => callOperation('b', {})"
        calls:
          b: second.b
  - id: second
    version: 1.0.0
    operations:
      b:
        type: read
        code: "() => callOperation('a', {})"
        calls:
          a: first.a
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'circular_call_dependency')).toBe(true);
    }
  });

  it.each([
    ['first declaration order', false],
    ['reversed declaration order', true],
  ])('does not collapse distinct call-graph nodes in %s', (_label, reversed) => {
    const caller = {
      id: 'graph@left',
      version: '1',
      operations: {
        read: {
          type: 'read',
          code: "() => callOperation('next', {})",
          calls: { next: 'graph.read' },
        },
      },
    };
    const callee = {
      id: 'graph',
      version: 'left@1',
      operations: {
        read: {
          type: 'read',
          code: '(input) => input',
        },
      },
    };
    const result = compileConnectors(
      JSON.stringify({ connectors: reversed ? [callee, caller] : [caller, callee] }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      expect(result.errors).not.toContainEqual(
        expect.objectContaining({ code: 'circular_call_dependency' }),
      );
    }
  });
});

describe('compute connector through the runtime (end to end)', () => {
  const MANIFEST = `
manifestVersion: "1"
server:
  name: text_tools
  version: 1.0.0
  title: Text Tools
connectors:
  text:
    id: text
    version: 1.0.0
tools:
  - name: slugify
    description: Turn a title into a URL slug.
    inputSchema:
      type: object
      properties:
        title:
          type: string
      required:
        - title
      additionalProperties: false
    fulfilment:
      use: text.slugify
      args:
        title: \${input.title}
`;

  it('compiles the manifest against the compute catalog and runs the sandboxed handler', async () => {
    const compiled = compileConnectors(slugCatalog());
    if (!compiled.ok) throw new Error('connector compile failed');

    const manifest = compile(MANIFEST, { catalog: new InMemoryCatalog(compiled.catalog) });
    if (!manifest.ok) {
      throw new Error(`manifest compile failed: ${JSON.stringify(manifest.errors)}`);
    }

    const deps: ExecuteDeps = {
      connectors: new InMemoryConnectorRegistry(compiled.connectors),
      broker: new StaticServiceBroker(credential),
    };
    const result = await executeTool(
      manifest.artifact,
      'slugify',
      { title: 'My First Post!' },
      deps,
    );
    expect(result).toEqual({ ok: true, output: { slug: 'my-first-post' } });
  });

  it('passes a non-scalar (array) argument through the manifest into the sandbox', async () => {
    const catalog = `
connectors:
  - id: num
    version: 1.0.0
    operations:
      stats:
        type: read
        input:
          type: object
          properties:
            values: { type: array }
          required: [values]
          additionalProperties: false
        output:
          type: object
          properties:
            sum: { type: number }
            mean: { type: number }
            max: { type: number }
          additionalProperties: false
        code: |
          (input) => {
            const xs = input.values;
            const sum = xs.reduce((a, b) => a + b, 0);
            return { sum, mean: sum / xs.length, max: Math.max(...xs) };
          }
`;
    const manifest = `
manifestVersion: "1"
server:
  name: numbers
  version: 1.0.0
  title: Numbers
connectors:
  num:
    id: num
    version: 1.0.0
tools:
  - name: stats
    description: Summary statistics over a list of numbers.
    inputSchema:
      type: object
      properties:
        values:
          type: array
          items: { type: number }
      required:
        - values
      additionalProperties: false
    fulfilment:
      use: num.stats
      args:
        values: \${input.values}
`;
    const compiled = compileConnectors(catalog);
    if (!compiled.ok)
      throw new Error(`connector compile failed: ${JSON.stringify(compiled.errors)}`);
    const m = compile(manifest, { catalog: new InMemoryCatalog(compiled.catalog) });
    if (!m.ok) throw new Error(`manifest compile failed: ${JSON.stringify(m.errors)}`);

    const deps: ExecuteDeps = {
      connectors: new InMemoryConnectorRegistry(compiled.connectors),
      broker: new StaticServiceBroker(credential),
    };
    const result = await executeTool(m.artifact, 'stats', { values: [2, 4, 6] }, deps);
    expect(result).toEqual({ ok: true, output: { sum: 12, mean: 4, max: 6 } });
  });

  it('lets a compute connector call a declared connector operation through the runtime host', async () => {
    const catalog = `
connectors:
  - id: text
    version: 1.0.0
    operations:
      shout:
        type: read
        input:
          type: object
          properties:
            s: { type: string }
          required: [s]
          additionalProperties: false
        output:
          type: object
          properties:
            loud: { type: string }
          additionalProperties: false
        code: "(input) => ({ loud: String(input.s).toUpperCase() })"
  - id: wrapper
    version: 1.0.0
    operations:
      decorate:
        type: read
        input:
          type: object
          properties:
            s: { type: string }
          required: [s]
          additionalProperties: false
        output:
          type: object
          properties:
            decorated: { type: string }
          additionalProperties: false
        calls:
          shout: text.shout
        code: |
          (input) => {
            const result = callOperation("shout", { s: input.s });
            return { decorated: "<<" + result.loud + ">>" };
          }
`;
    const manifest = `
manifestVersion: "1"
server:
  name: wrapper
  version: 1.0.0
  title: Wrapper
connectors:
  wrapper:
    id: wrapper
    version: 1.0.0
tools:
  - name: decorate
    description: Decorate text via a nested compute call.
    inputSchema:
      type: object
      properties:
        s: { type: string }
      required: [s]
      additionalProperties: false
    fulfilment:
      use: wrapper.decorate
      args:
        s: \${input.s}
`;
    const compiled = compileConnectors(catalog);
    if (!compiled.ok)
      throw new Error(`connector compile failed: ${JSON.stringify(compiled.errors)}`);
    const m = compile(manifest, { catalog: new InMemoryCatalog(compiled.catalog) });
    if (!m.ok) throw new Error(`manifest compile failed: ${JSON.stringify(m.errors)}`);

    const deps: ExecuteDeps = {
      connectors: new InMemoryConnectorRegistry(compiled.connectors),
      broker: new StaticServiceBroker(credential),
    };
    const result = await executeTool(m.artifact, 'decorate', { s: 'hello' }, deps);
    expect(result).toEqual({ ok: true, output: { decorated: '<<HELLO>>' } });
  });

  it('applies policy after hooks to host-call outputs before sandbox code receives them', async () => {
    const catalog = `
connectors:
  - id: text
    version: 1.0.0
    operations:
      shout:
        type: read
        input:
          type: object
          properties:
            s: { type: string }
          required: [s]
          additionalProperties: false
        output:
          type: object
          properties:
            loud: { type: string }
          additionalProperties: false
        code: "(input) => ({ loud: String(input.s).toUpperCase() })"
  - id: wrapper
    version: 1.0.0
    operations:
      decorate:
        type: read
        input:
          type: object
          properties:
            s: { type: string }
          required: [s]
          additionalProperties: false
        output:
          type: object
          properties:
            decorated: { type: string }
          additionalProperties: false
        calls:
          shout: text.shout
        code: |
          (input) => {
            const result = callOperation("shout", { s: input.s });
            return { decorated: "[" + result.loud + "]" };
          }
`;
    const manifest = `
manifestVersion: "1"
server:
  name: wrapper
  version: 1.0.0
  title: Wrapper
connectors:
  wrapper:
    id: wrapper
    version: 1.0.0
tools:
  - name: decorate
    description: Decorate text via a nested compute call.
    inputSchema:
      type: object
      properties:
        s: { type: string }
      required: [s]
      additionalProperties: false
    fulfilment:
      use: wrapper.decorate
      args:
        s: \${input.s}
`;
    const compiled = compileConnectors(catalog);
    if (!compiled.ok)
      throw new Error(`connector compile failed: ${JSON.stringify(compiled.errors)}`);
    const m = compile(manifest, { catalog: new InMemoryCatalog(compiled.catalog) });
    if (!m.ok) throw new Error(`manifest compile failed: ${JSON.stringify(m.errors)}`);

    const policy: PolicyGate = {
      before: async () => ({ allow: true }),
      after: async (ctx, output) => (ctx.connectorId === 'text' ? { loud: '[REDACTED]' } : output),
    };
    const deps: ExecuteDeps = {
      connectors: new InMemoryConnectorRegistry(compiled.connectors),
      broker: new StaticServiceBroker(credential),
      policy,
    };
    const result = await executeTool(m.artifact, 'decorate', { s: 'hello' }, deps);
    expect(result).toEqual({ ok: true, output: { decorated: '[[REDACTED]]' } });
  });

  it('routes host calls through policy before hooks and does not invoke denied targets', async () => {
    const catalog = `
connectors:
  - id: target
    version: 1.0.0
    operations:
      lookup:
        type: read
        input:
          type: object
          properties:
            id: { type: string }
          required: [id]
          additionalProperties: false
        output:
          type: object
          properties:
            value: { type: string }
          additionalProperties: false
        code: "(input) => ({ value: input.id })"
  - id: wrapper
    version: 1.0.0
    operations:
      run:
        type: read
        input:
          type: object
          properties:
            id: { type: string }
          required: [id]
          additionalProperties: false
        output:
          type: object
          properties:
            value: { type: string }
          additionalProperties: false
        calls:
          lookup: target.lookup
        code: "(input) => callOperation('lookup', { id: input.id })"
`;
    const manifest = `
manifestVersion: "1"
server:
  name: wrapper
  version: 1.0.0
  title: Wrapper
connectors:
  wrapper:
    id: wrapper
    version: 1.0.0
tools:
  - name: run
    description: Run nested lookup.
    inputSchema:
      type: object
      properties:
        id: { type: string }
      required: [id]
      additionalProperties: false
    fulfilment:
      use: wrapper.run
      args:
        id: \${input.id}
`;
    const compiled = compileConnectors(catalog);
    if (!compiled.ok)
      throw new Error(`connector compile failed: ${JSON.stringify(compiled.errors)}`);
    const m = compile(manifest, { catalog: new InMemoryCatalog(compiled.catalog) });
    if (!m.ok) throw new Error(`manifest compile failed: ${JSON.stringify(m.errors)}`);

    const targetCalls: unknown[] = [];
    const target = new InMemoryConnector('target', '1.0.0', {
      lookup: {
        signature: compiled.catalog.find((c) => c.id === 'target')?.operations.lookup ?? {
          type: 'read',
          input: {},
          output: {},
        },
        handler: (args) => {
          targetCalls.push(args);
          return { value: String(args.id) };
        },
      },
    });
    const wrapper = compiled.connectors.find((c) => c.id === 'wrapper');
    if (!wrapper) throw new Error('missing wrapper connector');
    const policy: PolicyGate = {
      before: async (ctx) =>
        ctx.connectorId === 'target'
          ? { allow: false, reason: 'nested target denied' }
          : { allow: true },
      after: async (_ctx, output) => output,
    };
    const deps: ExecuteDeps = {
      connectors: new InMemoryConnectorRegistry([wrapper, target]),
      broker: new StaticServiceBroker(credential),
      policy,
    };
    const result = await executeTool(m.artifact, 'run', { id: 'A1' }, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('connector_error');
      expect(result.error.message).not.toContain('nested target denied');
    }
    expect(targetCalls).toHaveLength(0);
  });

  it('routes host calls through the broker using the nested operation identity', async () => {
    const catalog = `
connectors:
  - id: target
    version: 1.0.0
    operations:
      lookup:
        type: read
        input:
          type: object
          properties:
            id: { type: string }
          required: [id]
          additionalProperties: false
        output:
          type: object
          properties:
            value: { type: string }
          additionalProperties: false
        code: "(input) => ({ value: input.id })"
  - id: wrapper
    version: 1.0.0
    operations:
      run:
        type: read
        input:
          type: object
          properties:
            id: { type: string }
          required: [id]
          additionalProperties: false
        output:
          type: object
          properties:
            value: { type: string }
          additionalProperties: false
        calls:
          lookup: target.lookup
        code: "(input) => callOperation('lookup', { id: input.id })"
`;
    const manifest = `
manifestVersion: "1"
server:
  name: wrapper
  version: 1.0.0
  title: Wrapper
connectors:
  wrapper:
    id: wrapper
    version: 1.0.0
tools:
  - name: run
    description: Run nested lookup.
    inputSchema:
      type: object
      properties:
        id: { type: string }
      required: [id]
      additionalProperties: false
    fulfilment:
      use: wrapper.run
      args:
        id: \${input.id}
`;
    const compiled = compileConnectors(catalog);
    if (!compiled.ok)
      throw new Error(`connector compile failed: ${JSON.stringify(compiled.errors)}`);
    const m = compile(manifest, { catalog: new InMemoryCatalog(compiled.catalog) });
    if (!m.ok) throw new Error(`manifest compile failed: ${JSON.stringify(m.errors)}`);

    const brokerCalls: unknown[] = [];
    const broker: CredentialBroker = {
      getCredential: async (request) => {
        brokerCalls.push(request);
        return credential;
      },
    };
    const deps: ExecuteDeps = {
      connectors: new InMemoryConnectorRegistry(compiled.connectors),
      broker,
    };
    const result = await executeTool(m.artifact, 'run', { id: 'A1' }, deps);
    expect(result).toEqual({ ok: true, output: { value: 'A1' } });
    expect(brokerCalls).toEqual([
      { connectorId: 'wrapper', connectorVersion: '1.0.0', operation: 'run' },
      { connectorId: 'target', connectorVersion: '1.0.0', operation: 'lookup' },
    ]);
  });

  it('detects signature drift on a host-call target before invoking it', async () => {
    const catalog = `
connectors:
  - id: target
    version: 1.0.0
    operations:
      lookup:
        type: read
        input:
          type: object
          properties:
            id: { type: string }
          required: [id]
          additionalProperties: false
        output:
          type: object
          properties:
            value: { type: string }
          additionalProperties: false
        code: "(input) => ({ value: input.id })"
  - id: wrapper
    version: 1.0.0
    operations:
      run:
        type: read
        input:
          type: object
          properties:
            id: { type: string }
          required: [id]
          additionalProperties: false
        output:
          type: object
          properties:
            value: { type: string }
          additionalProperties: false
        calls:
          lookup: target.lookup
        code: "(input) => callOperation('lookup', { id: input.id })"
`;
    const manifest = `
manifestVersion: "1"
server:
  name: wrapper
  version: 1.0.0
  title: Wrapper
connectors:
  wrapper:
    id: wrapper
    version: 1.0.0
tools:
  - name: run
    description: Run nested lookup.
    inputSchema:
      type: object
      properties:
        id: { type: string }
      required: [id]
      additionalProperties: false
    fulfilment:
      use: wrapper.run
      args:
        id: \${input.id}
`;
    const compiled = compileConnectors(catalog);
    if (!compiled.ok)
      throw new Error(`connector compile failed: ${JSON.stringify(compiled.errors)}`);
    const m = compile(manifest, { catalog: new InMemoryCatalog(compiled.catalog) });
    if (!m.ok) throw new Error(`manifest compile failed: ${JSON.stringify(m.errors)}`);

    const targetCalls: unknown[] = [];
    const driftedTarget = new InMemoryConnector('target', '1.0.0', {
      lookup: {
        signature: {
          type: 'read',
          input: {
            type: 'object',
            properties: { id: { type: 'number' } },
            required: ['id'],
            additionalProperties: false,
          },
          output: {
            type: 'object',
            properties: { value: { type: 'string' } },
            additionalProperties: false,
          },
        },
        handler: (args) => {
          targetCalls.push(args);
          return { value: String(args.id) };
        },
      },
    });
    const wrapper = compiled.connectors.find((c) => c.id === 'wrapper');
    if (!wrapper) throw new Error('missing wrapper connector');
    const deps: ExecuteDeps = {
      connectors: new InMemoryConnectorRegistry([wrapper, driftedTarget]),
      broker: new StaticServiceBroker(credential),
    };
    const result = await executeTool(m.artifact, 'run', { id: 'A1' }, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('connector_error');
      expect(result.error.message).not.toContain('signature has drifted');
    }
    expect(targetCalls).toHaveLength(0);
  });
});
