import { describe, expect, it } from 'vitest';
import { InMemoryCatalog } from '../src/catalog/in-memory.js';
import type { OperationSignature } from '../src/catalog/types.js';
import { compileManifest } from '../src/compile.js';
import { BUILTIN_RECORD_CATALOG_CONNECTOR } from '../src/native-record-operations.js';

/**
 * The public website projection (ADR 0201) is enforced at compile time so its failure modes are
 * unrepresentable rather than merely rejected at runtime. These cover the three invariants: every
 * projected name resolves, no projected fulfilment can read `${user}`, and an externally visible
 * side effect needs both projection and confirmation.
 */

const readSignature: OperationSignature = {
  type: 'read',
  input: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false },
  output: { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: false },
};

const actionSignature: OperationSignature = {
  type: 'action',
  input: { type: 'object', properties: { email: { type: 'string' } }, additionalProperties: false },
  output: { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: false },
};

const catalog = new InMemoryCatalog([
  {
    id: 'acme',
    version: '1.0.0',
    operations: { look_up: readSignature, book_demo: actionSignature },
  },
]);

const model = {
  kind: 'openai-compatible' as const,
  baseUrl: 'https://models.test/v1',
  model: 'demo',
  apiKey: 'ASSISTANT_MODEL_API_KEY',
};

interface ToolInput {
  readonly name: string;
  readonly operation?: string;
  readonly args?: Record<string, unknown>;
  readonly annotations?: Record<string, unknown>;
  readonly authorization?: Record<string, unknown>;
}

function app(input: {
  readonly mode: 'authenticated' | 'public' | 'mixed';
  readonly capabilities?: readonly { kind: string; name: string }[];
  readonly instructions?: string;
  readonly tools: readonly ToolInput[];
}): unknown {
  return {
    manifestVersion: '2',
    server: {
      name: 'acme_site',
      title: 'Acme Site',
      version: '1.0.0',
      assistant: {
        model,
        allowedOrigins: ['https://www.acme.test'],
        surfaces: [
          {
            mode: input.mode,
            origins: ['https://www.acme.test'],
            ...(input.capabilities ? { capabilities: input.capabilities } : {}),
            ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
          },
        ],
      },
    },
    connectors: { acme: { id: 'acme', version: '1.0.0' } },
    tools: input.tools.map((entry) => ({
      name: entry.name,
      description: `The ${entry.name} tool.`,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      ...(entry.annotations ? { annotations: entry.annotations } : {}),
      ...(entry.authorization ? { authorization: entry.authorization } : {}),
      fulfilment: {
        use: `acme.${entry.operation ?? 'look_up'}`,
        args: entry.args ?? {},
      },
    })),
  };
}

function errorCodes(result: ReturnType<typeof compileManifest>): readonly string[] {
  return result.ok ? [] : result.errors.map((error) => error.code);
}

describe('public website assistant projection', () => {
  it('round-trips bounded surface instructions and trims their edges', () => {
    const result = compileManifest(
      app({
        mode: 'public',
        capabilities: [{ kind: 'tool', name: 'look_up' }],
        instructions: '  Guide visitors consultatively.  ',
        tools: [{ name: 'look_up', annotations: { readOnlyHint: true } }],
      }),
      { catalog },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.server.assistant?.surfaces?.[0]?.instructions).toBe(
      'Guide visitors consultatively.',
    );
  });

  it.each(['   ', 'x'.repeat(4_001)])('rejects invalid surface instructions', (instructions) => {
    const result = compileManifest(
      app({
        mode: 'public',
        capabilities: [{ kind: 'tool', name: 'look_up' }],
        instructions,
        tools: [{ name: 'look_up', annotations: { readOnlyHint: true } }],
      }),
      { catalog },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.errors.some((error) => error.path === 'server.assistant.surfaces.0.instructions'),
    ).toBe(true);
  });

  it('rejects a capability that names no declared component', () => {
    const result = compileManifest(
      app({
        mode: 'public',
        capabilities: [
          { kind: 'tool', name: 'look_up' },
          { kind: 'tool', name: 'ghost' },
        ],
        tools: [{ name: 'look_up', annotations: { readOnlyHint: true } }],
      }),
      { catalog },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const unknown = result.errors.filter((error) => error.code === 'assistant_capability_unknown');
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.message).toContain('ghost');
    expect(unknown[0]?.path).toBe('server.assistant.surfaces[0].capabilities[1]');
  });

  it('rejects a projected tool that reads the signed-in user', () => {
    const result = compileManifest(
      app({
        mode: 'public',
        capabilities: [{ kind: 'tool', name: 'look_up' }],
        tools: [{ name: 'look_up', args: { id: '${user.id}' } }],
      }),
      { catalog },
    );

    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain('assistant_public_user_reference');
  });

  it('allows an unprojected tool to read the user', () => {
    const result = compileManifest(
      app({
        mode: 'public',
        capabilities: [{ kind: 'tool', name: 'look_up' }],
        tools: [
          { name: 'look_up', annotations: { readOnlyHint: true } },
          // Absent from `capabilities`, so the projection never reaches it and `${user}` is fine.
          { name: 'internal_audit', args: { id: '${user.id}' } },
        ],
      }),
      { catalog },
    );

    expect(result.ok).toBe(true);
  });

  it('makes an unannotated projected tool declare its intent', () => {
    const result = compileManifest(
      app({
        mode: 'public',
        capabilities: [{ kind: 'tool', name: 'look_up' }],
        tools: [{ name: 'look_up' }],
      }),
      { catalog },
    );

    // Fail-closed: silence is treated as an effect, not assumed safe.
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain('assistant_public_effect_unconfirmed');
  });

  it('requires confirmation on a projected external side effect', () => {
    const unconfirmed = compileManifest(
      app({
        mode: 'public',
        capabilities: [{ kind: 'tool', name: 'book_demo' }],
        tools: [
          {
            name: 'book_demo',
            operation: 'book_demo',
            annotations: { readOnlyHint: false },
          },
        ],
      }),
      { catalog },
    );

    expect(unconfirmed.ok).toBe(false);
    expect(errorCodes(unconfirmed)).toContain('assistant_public_effect_unconfirmed');

    const confirmed = compileManifest(
      app({
        mode: 'public',
        capabilities: [{ kind: 'tool', name: 'book_demo' }],
        tools: [
          {
            name: 'book_demo',
            operation: 'book_demo',
            annotations: { readOnlyHint: false, confirm: true },
          },
        ],
      }),
      { catalog },
    );

    expect(confirmed.ok).toBe(true);
  });

  it('leaves a projected read unconfirmed', () => {
    const result = compileManifest(
      app({
        mode: 'public',
        capabilities: [{ kind: 'tool', name: 'look_up' }],
        tools: [{ name: 'look_up', annotations: { readOnlyHint: true } }],
      }),
      { catalog },
    );

    expect(result.ok).toBe(true);
  });

  it('treats an ADR 0185 authorization requirement as needing identity', () => {
    const result = compileManifest(
      app({
        mode: 'public',
        capabilities: [{ kind: 'tool', name: 'look_up' }],
        tools: [
          {
            name: 'look_up',
            annotations: { readOnlyHint: true },
            // Touches no `${user}` expression, but cannot be satisfied without verified claims.
            authorization: { requiredScopes: ['orders.read'] },
          },
        ],
      }),
      { catalog },
    );

    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain('assistant_public_user_reference');
  });

  it('allows an identity-dependent capability on a mixed surface as its sign-in trigger', () => {
    const result = compileManifest(
      app({
        mode: 'mixed',
        capabilities: [{ kind: 'tool', name: 'look_up' }],
        tools: [
          { name: 'look_up', args: { id: '${user.id}' }, annotations: { readOnlyHint: true } },
        ],
      }),
      { catalog },
    );

    // The visitor signs in mid-conversation to reach it — ChatGPT's account-linking shape.
    expect(result.ok).toBe(true);
  });

  it('still requires confirmation for a side effect on a mixed surface', () => {
    const result = compileManifest(
      app({
        mode: 'mixed',
        capabilities: [{ kind: 'tool', name: 'book_demo' }],
        tools: [
          { name: 'book_demo', operation: 'book_demo', annotations: { readOnlyHint: false } },
        ],
      }),
      { catalog },
    );

    // Signing in proves who the visitor is; it does not pre-authorize an external effect.
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain('assistant_public_effect_unconfirmed');
  });

  it('constrains none of it on an authenticated projection', () => {
    const result = compileManifest(
      app({
        mode: 'authenticated',
        tools: [
          { name: 'look_up', args: { id: '${user.id}' } },
          {
            name: 'book_demo',
            operation: 'book_demo',
            annotations: { readOnlyHint: false },
          },
        ],
      }),
      { catalog },
    );

    expect(result.ok).toBe(true);
  });
});

/**
 * `webmcp` (ADR 0220, amended) is the assistant's default and any surface may override it in either
 * direction. What it governs is **discovery** — whether the embed registers this session's tools with
 * `document.modelContext`, and so whether a browser agent ever learns they exist. It is not a server
 * authority gate: the apps bridge serves any caller holding a valid session token, bounded by that
 * session's own authority, marker or no marker. A customer running a marketing surface and a
 * signed-in surface off one deployment needs to answer that discovery question per surface, which a
 * single deployment-wide switch cannot do.
 */
describe('a surface may set the WebMCP opt-in in either direction', () => {
  function withWebmcp(placement: 'assistant' | 'surface'): unknown {
    const webmcp = { enabled: true };
    return {
      manifestVersion: '2',
      server: {
        name: 'acme_site',
        title: 'Acme Site',
        version: '1.0.0',
        assistant: {
          model,
          allowedOrigins: ['https://www.acme.test'],
          ...(placement === 'assistant' ? { webmcp } : {}),
          surfaces: [
            {
              mode: 'public',
              origins: ['https://www.acme.test'],
              capabilities: [{ kind: 'tool', name: 'look_up' }],
              ...(placement === 'surface' ? { webmcp } : {}),
            },
          ],
        },
      },
      connectors: { acme: { id: 'acme', version: '1.0.0' } },
      tools: [
        {
          name: 'look_up',
          description: 'The look_up tool.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true },
          fulfilment: { use: 'acme.look_up', args: {} },
        },
      ],
    };
  }

  it('compiles the opt-in at the assistant, at a surface, and at both', () => {
    const assistant = compileManifest(withWebmcp('assistant'), { catalog });
    expect(assistant.ok).toBe(true);
    if (assistant.ok) {
      expect(assistant.artifact.server.assistant?.webmcp).toEqual({ enabled: true });
    }

    // The surface carries its own value through compilation. Whether it wins is the gateway's
    // question at session mint; the compiler's job is to stop losing it.
    const surface = compileManifest(withWebmcp('surface'), { catalog });
    expect(surface.ok, JSON.stringify(errorCodes(surface))).toBe(true);
    if (surface.ok) {
      expect(surface.artifact.server.assistant?.webmcp).toBeUndefined();
      expect(surface.artifact.server.assistant?.surfaces?.[0]?.webmcp).toEqual({ enabled: true });
    }
  });

  it('keeps a surface opting out of a deployment that opted in', () => {
    const manifest = withWebmcp('assistant') as {
      server: { assistant: { surfaces: { webmcp?: unknown }[] } };
    };
    manifest.server.assistant.surfaces[0].webmcp = { enabled: false };

    const result = compileManifest(manifest, { catalog });
    expect(result.ok, JSON.stringify(errorCodes(result))).toBe(true);
    if (result.ok) {
      // Both values survive: the deployment's default and the surface's refusal of it. Collapsing
      // them here would decide at compile time a question that belongs to the session's surface.
      expect(result.artifact.server.assistant?.webmcp).toEqual({ enabled: true });
      expect(result.artifact.server.assistant?.surfaces?.[0]?.webmcp).toEqual({ enabled: false });
    }
  });
});

/**
 * `continuity` (ADR 0223, clauses 11-16) is anonymous cross-page *display* continuity, so it is
 * declared per public or mixed surface and nowhere else.
 *
 * It is deliberately absent from an authenticated surface. That direction already reattaches through
 * clause 7, authorized by a backend-verified subject rather than by possession of a handle, so a
 * `continuity` block there would be a developer believing they had configured something that nothing
 * reads. The compiler refuses it rather than dropping it silently.
 */
describe('a public surface may declare anonymous cross-page continuity', () => {
  function withContinuity(
    continuity: unknown,
    mode: 'public' | 'mixed' | 'authenticated' = 'public',
  ): unknown {
    return {
      manifestVersion: '2',
      server: {
        name: 'acme_site',
        title: 'Acme Site',
        version: '1.0.0',
        assistant: {
          model,
          allowedOrigins: ['https://www.acme.test'],
          surfaces: [
            {
              mode,
              origins: ['https://www.acme.test'],
              capabilities: [{ kind: 'tool', name: 'look_up' }],
              ...(continuity === undefined ? {} : { continuity }),
            },
          ],
        },
      },
      connectors: { acme: { id: 'acme', version: '1.0.0' } },
      tools: [
        {
          name: 'look_up',
          description: 'The look_up tool.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true },
          fulfilment: { use: 'acme.look_up', args: {} },
        },
      ],
    };
  }

  it('carries the declaration through compilation for public and mixed surfaces', () => {
    for (const mode of ['public', 'mixed'] as const) {
      const result = compileManifest(
        withContinuity({ enabled: true, windowSeconds: 120, maxRestores: 2 }, mode),
        { catalog },
      );
      expect(result.ok, JSON.stringify(errorCodes(result))).toBe(true);
      if (result.ok) {
        expect(result.artifact.server.assistant?.surfaces?.[0]?.continuity).toEqual({
          enabled: true,
          windowSeconds: 120,
          maxRestores: 2,
        });
      }
    }
  });

  it('injects nothing when a surface stays silent, so continuity is off by default', () => {
    const result = compileManifest(withContinuity(undefined), { catalog });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact.server.assistant?.surfaces?.[0]?.continuity).toBeUndefined();
    }
  });

  it('refuses the declaration on an authenticated surface', () => {
    const result = compileManifest(withContinuity({ enabled: true }, 'authenticated'), { catalog });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.ok ? [] : result.errors)).toContain('continuity');
  });

  it('refuses a window or chain beyond the structural ceiling', () => {
    // The gateway clamps at runtime, but a developer who asks for more than the ceiling has made a
    // mistake, and silently narrowing it would hide that until someone measured the live behaviour.
    for (const beyond of [
      { enabled: true, windowSeconds: 601 },
      { enabled: true, maxRestores: 11 },
      { enabled: true, windowSeconds: -1 },
      { enabled: true, maxRestores: -1 },
      { enabled: true, windowSeconds: 1.5 },
    ]) {
      const result = compileManifest(withContinuity(beyond), { catalog });
      expect(result.ok, `expected ${JSON.stringify(beyond)} to be refused`).toBe(false);
    }
  });

  it('accepts the exact ceiling and the zero kill switch', () => {
    for (const bound of [
      { enabled: true, windowSeconds: 600, maxRestores: 10 },
      { enabled: false },
      { enabled: true, windowSeconds: 0 },
      { enabled: true, maxRestores: 0 },
    ]) {
      const result = compileManifest(withContinuity(bound), { catalog });
      expect(result.ok, JSON.stringify(errorCodes(result))).toBe(true);
    }
  });
});

/**
 * A messaging surface (ADR 0239) runs the conversation loop itself, so it can present a `collect`
 * interaction (ADR 0240) natively: the opener's fields are gathered in chat and its confirmed action
 * saves one native record. Everything the messaging profile cannot provide without an interaction
 * (a browser widget, an arbitrary write, an external connector call) is still refused, but with a
 * code that names the missing requirement rather than a blanket "unsupported".
 */
describe('messaging surface narrows to interaction-backed collection', () => {
  const brief = {
    type: 'object',
    properties: { workflow: { type: 'string' } },
    required: ['workflow'],
    additionalProperties: false,
  };
  const enquiry = {
    type: 'object',
    properties: {
      workflow: { type: 'string' },
      fullName: { type: 'string' },
      consentToContact: { type: 'boolean', const: true },
    },
    required: ['workflow', 'fullName', 'consentToContact'],
    additionalProperties: false,
  };
  const collect = (action: string) => ({
    kind: 'collect',
    action,
    initialValues: { workflow: { fromOutput: 'workflow' } },
    fields: [
      { key: 'fullName', control: 'text' },
      { key: 'consentToContact', control: 'consent' },
    ],
    review: 'all',
    outcome: { success: 'Saved.' },
  });
  const messagingCatalog = new InMemoryCatalog([
    {
      id: 'acme',
      version: '1.0.0',
      operations: { look_up: readSignature, book_demo: actionSignature },
    },
    BUILTIN_RECORD_CATALOG_CONNECTOR,
  ]);

  function messaging(
    capabilities: readonly { kind: string; name: string }[],
    options: { readonly withView?: boolean } = { withView: true },
  ): unknown {
    return {
      manifestVersion: '2',
      server: {
        name: 'acme_site',
        title: 'Acme Site',
        version: '1.0.0',
        assistant: {
          model: { kind: 'noodle-managed' },
          allowedOrigins: [],
          surfaces: [{ kind: 'messaging', channel: 'whatsapp', mode: 'public', capabilities }],
        },
      },
      connectors: {
        acme: { id: 'acme', version: '1.0.0' },
        records: { id: 'noodle_records', version: '1.0.0' },
      },
      widgets: [
        { name: 'card', tool: 'show_card', html: '<main/>' },
        ...(options.withView
          ? [{ name: 'contact_widget', tool: 'open_contact_form', html: '<main/>' }]
          : []),
      ],
      tools: [
        {
          name: 'open_contact_form',
          description: 'Opener.',
          inputSchema: brief,
          outputSchema: brief,
          annotations: { readOnlyHint: true },
          fulfilment: { steps: [], output: { workflow: '${input.workflow}' } },
          interaction: collect('submit_enquiry'),
        },
        {
          name: 'submit_enquiry',
          description: 'Native action.',
          inputSchema: enquiry,
          annotations: { readOnlyHint: false, confirm: true },
          visibility: ['app'],
          fulfilment: {
            steps: [
              {
                id: 'saved',
                use: 'records.submit_record',
                args: { collection: 'leads', payload: { contact_name: '${input.fullName}' } },
              },
            ],
            output: { ok: '${steps.saved.ok}' },
          },
        },
        {
          name: 'open_demo_request',
          description: 'Opener whose action leaves the platform.',
          inputSchema: brief,
          outputSchema: brief,
          annotations: { readOnlyHint: true },
          fulfilment: { steps: [], output: { workflow: '${input.workflow}' } },
          interaction: collect('book_external'),
        },
        {
          name: 'book_external',
          description: 'External action.',
          inputSchema: enquiry,
          annotations: { readOnlyHint: false, confirm: true },
          fulfilment: { use: 'acme.book_demo', args: { email: '${input.fullName}' } },
        },
        {
          name: 'show_card',
          description: 'Widget read without an interaction.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true },
          fulfilment: { steps: [], output: { ok: true } },
        },
        {
          name: 'health',
          description: 'Pure read.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true },
          fulfilment: { steps: [], output: { ok: true } },
        },
        {
          name: 'look_up',
          description: 'Connector read.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true },
          fulfilment: { use: 'acme.look_up', args: { id: 'x' } },
        },
        {
          name: 'bare_write',
          description: 'Write without an interaction.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: false, confirm: true },
          fulfilment: { steps: [], output: { ok: true } },
        },
      ],
    };
  }

  const tool = (name: string) => ({ kind: 'tool', name });

  it('allows an opener and its native records action selected together, with and without a catalog', () => {
    const selection = [tool('open_contact_form'), tool('submit_enquiry'), tool('health')];
    const resolved = compileManifest(messaging(selection), { catalog: messagingCatalog });
    expect(resolved.ok, JSON.stringify(errorCodes(resolved))).toBe(true);
    const shapeOnly = compileManifest(messaging(selection));
    expect(shapeOnly.ok, JSON.stringify(errorCodes(shapeOnly))).toBe(true);
    // A view-less opener rides on the platform renderer alone and is equally welcome.
    const viewless = compileManifest(messaging(selection, { withView: false }), {
      catalog: messagingCatalog,
    });
    expect(viewless.ok, JSON.stringify(errorCodes(viewless))).toBe(true);
  });

  it('names the unselected action when an opener is selected alone', () => {
    for (const withView of [true, false]) {
      const result = compileManifest(messaging([tool('open_contact_form')], { withView }), {
        catalog: messagingCatalog,
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      const missing = result.errors.filter((error) => error.code === 'channel_dependency_missing');
      expect(missing).toHaveLength(1);
      expect(missing[0]?.message).toContain('open_contact_form');
      expect(missing[0]?.message).toContain('submit_enquiry');
      expect(missing[0]?.path).toBe('tools.open_contact_form');
    }
  });

  it('refuses the action selected without its opener as a write the profile cannot collect for', () => {
    const result = compileManifest(messaging([tool('submit_enquiry')]), {
      catalog: messagingCatalog,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const refused = result.errors.filter(
      (error) => error.code === 'channel_requirement_unsupported',
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]?.path).toBe('tools.submit_enquiry');
    expect(refused[0]?.message).toMatch(/write/);
  });

  it('refuses an action whose operation leaves the native records connector', () => {
    const result = compileManifest(messaging([tool('open_demo_request'), tool('book_external')]), {
      catalog: messagingCatalog,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const refused = result.errors.filter(
      (error) => error.code === 'channel_requirement_unsupported',
    );
    expect(refused.map((error) => error.path)).toEqual(['tools.book_external']);
    expect(refused[0]?.message).toMatch(/connector/);
  });

  it.each([
    ['a widget without an interaction', 'show_card', /UI/],
    ['a write without an interaction', 'bare_write', /write/],
    ['a connector read', 'look_up', /connector/],
  ])('still refuses %s, naming the requirement', (_label, name, requirement) => {
    const result = compileManifest(messaging([tool(name)]), { catalog: messagingCatalog });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const refused = result.errors.filter(
      (error) => error.code === 'channel_requirement_unsupported',
    );
    expect(refused.map((error) => error.path)).toEqual([`tools.${name}`]);
    expect(refused[0]?.message).toMatch(requirement);
    expect(errorCodes(result)).not.toContain('assistant_messaging_unsupported');
  });

  it('keeps the kind gate for resources and prompts under its existing code', () => {
    const manifest = messaging([tool('health'), { kind: 'resource', name: 'faq' }]) as {
      resources?: unknown[];
    };
    manifest.resources = [
      { name: 'faq', uri: 'faq://all', fulfilment: { steps: [], output: { text: 'faq' } } },
    ];
    const result = compileManifest(manifest, { catalog: messagingCatalog });
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain('assistant_messaging_unsupported');
  });
});
