import type { ArtifactTool, RuntimeArtifact } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import {
  mapExecutionError,
  mapPromptMessages,
  mapPromptsList,
  mapResourceContents,
  mapResourcesList,
  mapResourceTemplatesList,
  mapTool,
  mapToolOutput,
  mapToolsList,
  redactWidgetLinkedOutput,
} from '../src/index.js';

describe('mapToolOutput', () => {
  it('maps object output to text plus structuredContent', () => {
    expect(mapToolOutput({ ok: true })).toEqual({
      content: [{ type: 'text', text: '{"ok":true}' }],
      structuredContent: { ok: true },
      isError: false,
    });
  });

  it('carries arrays and nested objects through structuredContent', () => {
    // List-shaped output (carousels, menus, search results) must reach widgets intact.
    const output = {
      items: [
        { name: 'Falafel Wrap', price: 12 },
        { name: 'Lentil Soup', price: 7 },
      ],
      meta: { total: 2 },
    };
    expect(mapToolOutput(output).structuredContent).toEqual(output);
  });

  it('maps non-object outputs to text only', () => {
    expect(mapToolOutput('hello')).toEqual({
      content: [{ type: 'text', text: 'hello' }],
      isError: false,
    });
    expect(mapToolOutput(7)).toEqual({
      content: [{ type: 'text', text: '7' }],
      isError: false,
    });
    expect(mapToolOutput([1, 2])).toEqual({
      content: [{ type: 'text', text: '[1,2]' }],
      isError: false,
    });
    expect(mapToolOutput(null)).toEqual({
      content: [{ type: 'text', text: 'null' }],
      isError: false,
    });
  });
});

describe('redactWidgetLinkedOutput', () => {
  it('redacts credential-shaped fields before widget delivery', () => {
    expect(
      redactWidgetLinkedOutput({
        ok: true,
        token: 'secret-token-value',
        nested: {
          Authorization: 'Bearer abc.def.ghi',
          visible: 'safe',
          items: [{ api_key: '123456789012345678901234567890' }],
        },
      }),
    ).toEqual({
      ok: true,
      token: '[REDACTED]',
      nested: {
        Authorization: '[REDACTED]',
        visible: 'safe',
        items: [{ api_key: '[REDACTED]' }],
      },
    });
  });

  it('keeps redacted widget-linked credentials out of model-visible tool output', () => {
    const result = mapToolOutput(
      redactWidgetLinkedOutput({
        ok: true,
        token: 'secret-token-value',
        nested: { authorization: 'Bearer abc.def.ghi', visible: 'safe' },
      }),
    );

    expect(JSON.stringify(result.content)).not.toContain('secret-token-value');
    expect(JSON.stringify(result.structuredContent)).not.toContain('secret-token-value');
    expect(JSON.stringify(result.content)).not.toContain('Bearer abc.def.ghi');
    expect(JSON.stringify(result.structuredContent)).not.toContain('Bearer abc.def.ghi');
    expect(result.structuredContent).toEqual({
      ok: true,
      token: '[REDACTED]',
      nested: { authorization: '[REDACTED]', visible: 'safe' },
    });
  });

  it('keeps missing secret names visible as configuration metadata', () => {
    expect(
      redactWidgetLinkedOutput({
        ok: false,
        code: 'credential_unavailable',
        missingSecrets: ['API_TOKEN'],
        secretValue: 'raw-value',
      }),
    ).toEqual({
      ok: false,
      code: 'credential_unavailable',
      missingSecrets: ['API_TOKEN'],
      secretValue: '[REDACTED]',
    });
  });

  it('keeps a string-valued model-authored manifest document verbatim even with secret-shaped prose', () => {
    // get_draft is widget-linked, so its output is value-redacted. A draft.manifest is a document the
    // MODEL itself wrote and round-trips back through set_draft — the model channel is not a secrecy
    // boundary for content the model authored. Prose like 'Bearer token' inside it matches the
    // SENSITIVE_VALUE pattern; without the allowlist the whole document collapses to '[REDACTED]' and
    // the model writes the destroyed document back. The exact keys `manifest`/`connectors` (string-valued)
    // are spared.
    expect(
      redactWidgetLinkedOutput({
        draft: {
          manifest: 'uses Bearer token auth via the broker',
          connectors: 'github: pinned to sha; uses Bearer token at runtime',
        },
      }),
    ).toEqual({
      draft: {
        manifest: 'uses Bearer token auth via the broker',
        connectors: 'github: pinned to sha; uses Bearer token at runtime',
      },
    });
  });

  it('keeps a JWT-looking triple inside a model-authored manifest string verbatim', () => {
    // A manifest the model wrote may legitimately contain a JWT-looking example value. Because the model
    // authored it (and round-trips it back), the string-valued `manifest` document is preserved verbatim
    // rather than collapsed by the SENSITIVE_VALUE JWT pattern.
    const manifest = 'example token: aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc';
    expect(redactWidgetLinkedOutput({ draft: { manifest } })).toEqual({ draft: { manifest } });
  });

  it('still redacts a key actually named like a credential, including under a draft document', () => {
    // The allowlist spares only the exact keys `manifest`/`connectors`; SENSITIVE_KEY behavior is
    // unchanged for keys actually named token/secret/apiKey/etc.
    expect(
      redactWidgetLinkedOutput({
        draft: { manifest: 'safe prose', apiKey: 'live-key-value' },
      }),
    ).toEqual({
      draft: { manifest: 'safe prose', apiKey: '[REDACTED]' },
    });
  });

  it('redacts a non-string manifest object value (allowlist is for string documents only)', () => {
    // The allowlist applies only when `manifest`/`connectors` are string-valued draft documents. An
    // object-shaped `manifest` is still walked, so credential-shaped leaves inside it are redacted.
    expect(
      redactWidgetLinkedOutput({
        manifest: { token: 'leak-me', name: 'demo' },
      }),
    ).toEqual({
      manifest: { token: '[REDACTED]', name: 'demo' },
    });
  });
});

describe('tool result _meta', () => {
  it('ignores result metadata inherited from the output prototype', () => {
    const inheritedMeta = {
      noodle: { app: { confirmToken: 'prototype-only-token' } },
    };
    const output = Object.assign(Object.create({ __noodleResultMeta: inheritedMeta }), {
      ok: true,
    }) as Record<string, unknown>;

    const result = mapToolOutput(output);

    expect(result).toEqual({
      content: [{ type: 'text', text: '{"ok":true}' }],
      structuredContent: output,
      isError: false,
    });
    expect(result._meta).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('prototype-only-token');
  });

  it('preserves an own __proto__ output key without mutating the projection prototype', () => {
    const output = Object.create(null) as Record<string, unknown>;
    output.ok = true;
    output.__proto__ = { polluted: 'must-remain-data' };
    output.__noodleResultMeta = { noodle: { source: 'test' } };

    const result = mapToolOutput(output);
    const structured = result.structuredContent as Record<string, unknown>;

    expect(result.content).toEqual([
      {
        type: 'text',
        text: '{"ok":true,"__proto__":{"polluted":"must-remain-data"}}',
      },
    ]);
    expect(result._meta).toEqual({ noodle: { source: 'test' } });
    expect(Object.getPrototypeOf(structured)).toBeNull();
    expect(Object.hasOwn(structured, '__proto__')).toBe(true);
    expect(structured.__proto__).toEqual({ polluted: 'must-remain-data' });
    expect(structured.polluted).toBeUndefined();
  });

  it('extracts reserved result metadata without echoing it as model-visible content', () => {
    const result = mapToolOutput({
      ok: true,
      deploymentId: 'hello-1234',
      __noodleResultMeta: {
        noodle: { app: { confirmToken: 'raw-confirm-token' } },
      },
    });
    expect(result).toEqual({
      content: [{ type: 'text', text: '{"ok":true,"deploymentId":"hello-1234"}' }],
      structuredContent: { ok: true, deploymentId: 'hello-1234' },
      isError: false,
      _meta: { noodle: { app: { confirmToken: 'raw-confirm-token' } } },
    });
    expect(JSON.stringify(result.content)).not.toContain('raw-confirm-token');
    expect(JSON.stringify(result.structuredContent)).not.toContain('raw-confirm-token');
  });

  it('maps connector projection metadata to MCP _meta only', () => {
    const result = mapToolOutput({
      title: 'Product',
      __noodleResultMeta: {
        noodle: {
          projection: {
            widgetMeta: { internalId: 'sku_123' },
            source: { label: 'Catalog API' },
            freshness: { ttlMs: 60_000, stale: false },
          },
        },
      },
    });
    expect(result).toEqual({
      content: [{ type: 'text', text: '{"title":"Product"}' }],
      structuredContent: { title: 'Product' },
      isError: false,
      _meta: {
        noodle: {
          projection: {
            widgetMeta: { internalId: 'sku_123' },
            source: { label: 'Catalog API' },
            freshness: { ttlMs: 60_000, stale: false },
          },
        },
      },
    });
    expect(JSON.stringify(result.content)).not.toContain('sku_123');
    expect(JSON.stringify(result.structuredContent)).not.toContain('sku_123');
  });
});

describe('mapTool (_meta widget link)', () => {
  const base: ArtifactTool = {
    name: 'open_ticket',
    description: 'Open a ticket.',
    inputSchema: { type: 'object' },
    fulfilment: { kind: 'flow', steps: [], output: {} },
  };

  it('carries the tool _meta (MCP Apps ui.resourceUri link) onto the descriptor', () => {
    const tool: ArtifactTool = { ...base, _meta: { ui: { resourceUri: 'ui://demo/ticket_card' } } };
    expect(mapTool(tool)).toEqual({
      name: 'open_ticket',
      description: 'Open a ticket.',
      inputSchema: { type: 'object' },
      _meta: { ui: { resourceUri: 'ui://demo/ticket_card' } },
    });
  });

  it('carries tool annotations onto the descriptor', () => {
    const tool: ArtifactTool = {
      ...base,
      annotations: { readOnlyHint: true, openWorldHint: false },
    };
    expect(mapTool(tool)).toEqual({
      name: 'open_ticket',
      description: 'Open a ticket.',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true, openWorldHint: false },
    });
  });

  it('carries the human-readable tool title onto the descriptor', () => {
    expect(mapTool({ ...base, title: 'Open a support ticket' })).toEqual({
      name: 'open_ticket',
      title: 'Open a support ticket',
      description: 'Open a ticket.',
      inputSchema: { type: 'object' },
    });
  });

  it('omits _meta when the tool declares none', () => {
    expect(mapTool(base)).toEqual({
      name: 'open_ticket',
      description: 'Open a ticket.',
      inputSchema: { type: 'object' },
    });
  });

  it('advertises the internal retry envelope only for guided-input tools', () => {
    const guided: ArtifactTool = {
      ...base,
      inputSchema: {
        type: 'object',
        properties: { employeeId: { type: 'string' } },
        additionalProperties: false,
      },
      fulfilment: {
        kind: 'flow',
        steps: [
          {
            kind: 'elicit',
            id: 'equipment',
            message: 'What do you need?',
            requestedSchema: { type: 'object', properties: {} },
          },
        ],
        output: {},
      },
    };

    expect(mapTool(guided).inputSchema).toMatchObject({
      properties: {
        employeeId: { type: 'string' },
        __noodleInteraction: {
          type: 'object',
          required: ['responses'],
          properties: { responses: { type: 'object' } },
        },
      },
      additionalProperties: false,
    });
    expect(mapTool(base).inputSchema).toEqual({ type: 'object' });
  });

  it('does not replace an authored field that happens to use the adapter name', () => {
    const authored = { type: 'string', description: 'An authored business field.' };
    const guided: ArtifactTool = {
      ...base,
      inputSchema: {
        type: 'object',
        properties: { __noodleInteraction: authored },
        additionalProperties: false,
      },
      fulfilment: {
        kind: 'flow',
        steps: [
          {
            kind: 'elicit',
            id: 'details',
            message: 'What details?',
            requestedSchema: { type: 'object', properties: {} },
          },
        ],
        output: {},
      },
    };

    expect(
      (mapTool(guided).inputSchema.properties as Record<string, unknown>).__noodleInteraction,
    ).toEqual(authored);
  });
});

describe('mapToolsList (visibility filter, W2.5)', () => {
  const tool = (name: string, _meta?: ArtifactTool['_meta']): ArtifactTool => ({
    name,
    description: name,
    inputSchema: { type: 'object' },
    fulfilment: { kind: 'flow', steps: [], output: {} },
    ...(_meta ? { _meta } : {}),
  });

  const artifact = {
    tools: [
      tool('classify'), // no visibility → visible
      tool('open_ticket', {
        ui: { resourceUri: 'ui://demo/ticket_card', visibility: ['model', 'app'] },
      }),
      tool('escalate_ticket', { ui: { visibility: ['app'] } }), // app-only → hidden
    ],
  } as unknown as RuntimeArtifact;

  it('keeps app-only tools discoverable with visibility metadata for MCP Apps hosts', () => {
    const names = mapToolsList(artifact).tools.map((t) => t.name);
    expect(names).toEqual(['classify', 'open_ticket', 'escalate_ticket']);
    expect(mapToolsList(artifact).tools.find((t) => t.name === 'escalate_ticket')?._meta).toEqual({
      ui: { visibility: ['app'] },
    });
  });

  it('still carries _meta (resourceUri + visibility) on a listed tool', () => {
    const open = mapToolsList(artifact).tools.find((t) => t.name === 'open_ticket');
    expect(open?._meta).toEqual({
      ui: { resourceUri: 'ui://demo/ticket_card', visibility: ['model', 'app'] },
    });
  });
});

describe('mapExecutionError', () => {
  it('maps model-actionable execution errors to isError tool results', () => {
    expect(mapExecutionError({ code: 'arg_invalid', message: 'bad arg' })).toEqual({
      result: { content: [{ type: 'text', text: 'bad arg' }], isError: true },
    });
  });

  it('maps safe credential diagnostics to a structured model-actionable result', () => {
    expect(
      mapExecutionError({
        code: 'credential_unavailable',
        message: 'credential unavailable for operation "get_order"',
        reason: 'caller_identity_not_customer',
        fix: 'Authenticate through the configured customer OIDC provider.',
        next: ['noodle auth doctor --live'],
      }),
    ).toEqual({
      result: {
        content: [
          {
            type: 'text',
            text: 'credential unavailable for operation "get_order"\nFix: Authenticate through the configured customer OIDC provider.\nNext: noodle auth doctor --live',
          },
        ],
        structuredContent: {
          error: {
            code: 'credential_unavailable',
            reason: 'caller_identity_not_customer',
            fix: 'Authenticate through the configured customer OIDC provider.',
            next: ['noodle auth doctor --live'],
          },
        },
        isError: true,
      },
    });
  });

  it('maps only the allowlisted oversized-response reason to structured connector diagnostics', () => {
    expect(
      mapExecutionError({
        code: 'connector_error',
        message: 'connector failed for operation "search"',
        reason: 'response_too_large',
      }),
    ).toEqual({
      result: {
        content: [
          {
            type: 'text',
            text: 'connector failed for operation "search"',
          },
        ],
        structuredContent: {
          error: {
            code: 'connector_error',
            reason: 'response_too_large',
          },
        },
        isError: true,
      },
    });

    expect(
      mapExecutionError({
        code: 'connector_error',
        message: 'connector failed for operation "search"',
        reason: 'customer-42 Bearer secret-token-value',
      }),
    ).toEqual({
      result: {
        content: [
          {
            type: 'text',
            text: 'connector failed for operation "search"',
          },
        ],
        isError: true,
      },
    });
  });

  it('maps connector time-budget reasons to structured connector diagnostics', () => {
    for (const reason of ['timeout', 'queue_timeout'] as const) {
      expect(
        mapExecutionError({
          code: 'connector_error',
          message: 'connector failed for operation "search"',
          reason,
        }),
      ).toEqual({
        result: {
          content: [
            {
              type: 'text',
              text: 'connector failed for operation "search"',
            },
          ],
          structuredContent: {
            error: {
              code: 'connector_error',
              reason,
            },
          },
          isError: true,
        },
      });
    }
  });

  it('maps an exhausted monthly billing allowance to a portable tool execution error', () => {
    expect(
      mapExecutionError({
        code: 'usage_limit_exceeded',
        message: 'Monthly MCP call limit reached. Usage resets at 2026-08-16T08:00:00.000Z.',
        reason: 'billing_usage_limit_exceeded',
        resetAt: '2026-08-16T08:00:00.000Z',
      }),
    ).toEqual({
      result: {
        content: [
          {
            type: 'text',
            text: 'Monthly MCP call limit reached. Usage resets at 2026-08-16T08:00:00.000Z.',
          },
        ],
        isError: true,
      },
    });
  });

  it('keeps authoritative-meter infrastructure failures on the internal-error channel', () => {
    expect(
      mapExecutionError({
        code: 'execution_admission_error',
        message: 'tool execution admission failed',
      }),
    ).toEqual({
      error: { code: -32603, message: 'tool execution admission failed' },
    });
  });

  it('maps a suppressed billing retry to a portable tool execution error', () => {
    expect(
      mapExecutionError({
        code: 'duplicate_execution_suppressed',
        message:
          'This retry was already admitted. Duplicate connector execution was suppressed; verify the original side effect before issuing a new request.',
        reason: 'billing_usage_duplicate_suppressed',
      }),
    ).toEqual({
      result: {
        content: [
          {
            type: 'text',
            text: 'This retry was already admitted. Duplicate connector execution was suppressed; verify the original side effect before issuing a new request.',
          },
        ],
        isError: true,
      },
    });
  });

  it('maps unknown tools to invalid-params protocol errors', () => {
    expect(mapExecutionError({ code: 'unknown_tool', message: 'nope' })).toEqual({
      error: { code: -32602, message: 'nope' },
    });
  });

  it('maps server-side execution faults to internal protocol errors', () => {
    expect(mapExecutionError({ code: 'policy_denied', message: 'blocked' })).toEqual({
      error: { code: -32603, message: 'blocked' },
    });
  });
});

const artifactWithResourcesAndPrompts = {
  artifactSchemaVersion: '0.4.0',
  resolution: 'resolved',
  source: { manifestName: 'demo', manifestVersion: '1.0.0' },
  server: { name: 'demo', version: '1.0.0' },
  tools: [],
  resources: [
    {
      name: 'fixed',
      uri: 'docs://fixed',
      title: 'Fixed',
      description: 'Fixed doc.',
      mimeType: 'text/markdown',
      isTemplate: false,
      fulfilment: { kind: 'flow', steps: [], output: {} },
    },
    {
      name: 'ticket',
      uri: 'tickets://{id}',
      title: 'Ticket',
      description: 'Ticket doc.',
      isTemplate: true,
      variables: ['id'],
      fulfilment: { kind: 'flow', steps: [], output: {} },
    },
  ],
  prompts: [
    {
      name: 'triage',
      title: 'Triage',
      description: 'Triage prompt.',
      arguments: [{ name: 'id', description: 'ticket id', required: true }],
      fulfilment: { kind: 'flow', steps: [], output: {} },
    },
    {
      name: 'no_args',
      fulfilment: { kind: 'flow', steps: [], output: {} },
    },
  ],
  capabilities: { tools: [] },
} as unknown as RuntimeArtifact;

describe('resource and prompt list mapping', () => {
  it('lists only fixed resources with descriptor metadata', () => {
    expect(mapResourcesList(artifactWithResourcesAndPrompts)).toEqual({
      resources: [
        {
          uri: 'docs://fixed',
          name: 'fixed',
          title: 'Fixed',
          description: 'Fixed doc.',
          mimeType: 'text/markdown',
        },
      ],
    });
  });

  it('lists only templated resources with descriptor metadata', () => {
    expect(mapResourceTemplatesList(artifactWithResourcesAndPrompts)).toEqual({
      resourceTemplates: [
        {
          uriTemplate: 'tickets://{id}',
          name: 'ticket',
          title: 'Ticket',
          description: 'Ticket doc.',
        },
      ],
    });
  });

  it('lists prompts with metadata and omits arguments when none are declared', () => {
    expect(mapPromptsList(artifactWithResourcesAndPrompts)).toEqual({
      prompts: [
        {
          name: 'triage',
          title: 'Triage',
          description: 'Triage prompt.',
          arguments: [{ name: 'id', description: 'ticket id', required: true }],
        },
        { name: 'no_args' },
      ],
    });
  });
});

describe('widget (ui://) resource listing', () => {
  const artifactWithWidget = {
    artifactSchemaVersion: '0.4.0',
    resolution: 'resolved',
    source: { manifestName: 'demo', manifestVersion: '1.0.0' },
    server: { name: 'demo', version: '1.0.0' },
    tools: [],
    resources: [
      {
        name: 'ticket_card',
        uri: 'ui://demo/ticket_card',
        mimeType: 'text/html;profile=mcp-app',
        isTemplate: false,
        fulfilment: { kind: 'flow', steps: [], output: {} },
        _meta: { ui: { csp: { connectDomains: ['https://api.example.com'] } } },
      },
    ],
    capabilities: { tools: [], resources: ['ticket_card'] },
  } as unknown as RuntimeArtifact;

  it('lists the ui:// widget with its mime type and _meta capability block', () => {
    expect(mapResourcesList(artifactWithWidget)).toEqual({
      resources: [
        {
          uri: 'ui://demo/ticket_card',
          name: 'ticket_card',
          mimeType: 'text/html;profile=mcp-app',
          _meta: { ui: { csp: { connectDomains: ['https://api.example.com'] } } },
        },
      ],
    });
  });

  it('serves the widget html as text/html;profile=mcp-app content (bridge injected, W2)', () => {
    const r = mapResourceContents('ui://demo/ticket_card', 'text/html;profile=mcp-app', {
      value: '<main>Hi</main>',
    });
    expect(r.contents[0]?.uri).toBe('ui://demo/ticket_card');
    expect(r.contents[0]?.mimeType).toBe('text/html;profile=mcp-app');
    expect(r.contents[0]?.text).toContain('<main>Hi</main>'); // author body preserved
    expect(r.contents[0]?.text).toContain('globalThis.ExtApps'); // ext-apps bridge injected at serve time
  });
});

describe('mapResourceContents', () => {
  it('maps a string value to text content with the resource mime type', () => {
    expect(mapResourceContents('docs://x', 'text/markdown', { value: '# X' })).toEqual({
      contents: [{ uri: 'docs://x', mimeType: 'text/markdown', text: '# X' }],
    });
  });

  it('carries the resource _meta on every read contents item', () => {
    // ChatGPT reads widget CSP/domain from the `resources/read` contents `_meta`, not only the
    // listing — dropping it here is why declared CSP looked "not set" to the host.
    const meta = {
      ui: { csp: { connectDomains: ['https://api.example.com'] } },
      'openai/widgetCSP': { connect_domains: ['https://api.example.com'] },
    };
    const read = mapResourceContents(
      'ui://demo/w',
      'text/html;profile=mcp-app',
      { value: '<html><body>x</body></html>' },
      meta,
    );
    expect(read.contents[0]?._meta).toEqual(meta);

    const blobRead = mapResourceContents(
      'docs://x',
      undefined,
      { value: { blob: 'aGk=', mimeType: 'image/png' } },
      meta,
    );
    expect(blobRead.contents[0]?._meta).toEqual(meta);
  });

  it('projects widget domains onto text and blob contents without mutating stored metadata', () => {
    const meta = Object.freeze({
      ui: Object.freeze({ domain: 'https://widgets.example.com', prefersBorder: true }),
    });
    const projection = {
      host: 'claude' as const,
      mcpServerUrl: 'https://mcp.test/endpoint',
    };

    const textRead = mapResourceContents(
      'ui://demo/w',
      'text/html;profile=mcp-app',
      { value: '<main>Widget</main>' },
      meta,
      projection,
    );
    const blobRead = mapResourceContents(
      'blob://demo/w',
      'application/octet-stream',
      { value: { blob: 'aGk=' } },
      meta,
      projection,
    );

    expect(textRead.contents[0]?._meta).toMatchObject({
      ui: { domain: expect.stringMatching(/^[a-f0-9]{32}\.claudemcpcontent\.com$/) },
      'openai/widgetDomain': 'https://widgets.example.com',
    });
    expect(blobRead.contents[0]?._meta).toEqual(textRead.contents[0]?._meta);
    expect(meta).toEqual({
      ui: { domain: 'https://widgets.example.com', prefersBorder: true },
    });
  });

  it('maps an object with text to text content', () => {
    expect(mapResourceContents('docs://x', undefined, { value: { text: 'hello' } })).toEqual({
      contents: [{ uri: 'docs://x', text: 'hello' }],
    });
  });

  it('maps an object with blob and per-content mime type to blob content', () => {
    expect(
      mapResourceContents('img://x', 'application/octet-stream', {
        value: { blob: 'YmFzZTY0', mimeType: 'image/png' },
      }),
    ).toEqual({
      contents: [{ uri: 'img://x', mimeType: 'image/png', blob: 'YmFzZTY0' }],
    });
  });

  it('falls back to JSON text for non-string structured values', () => {
    expect(mapResourceContents('data://x', undefined, { value: { ok: true } })).toEqual({
      contents: [{ uri: 'data://x', text: '{"ok":true}' }],
    });
  });

  it('maps a bare content entry { uri, mimeType, text } by reading its text', () => {
    // The authoring recipe's bare shape: the runtime reads `text` and uses the resource's own
    // uri/mimeType, so the returned uri/mimeType on the entry are redundant (never double-wrapped).
    expect(
      mapResourceContents('docs://changelog', 'text/markdown', {
        value: { uri: 'docs://changelog', mimeType: 'text/markdown', text: '# Changelog' },
      }),
    ).toEqual({
      contents: [{ uri: 'docs://changelog', mimeType: 'text/markdown', text: '# Changelog' }],
    });
  });

  it('throws on a { contents: [...] } wrapper instead of double-wrapping it as JSON', () => {
    // The double-wrap defect: authoring `fulfil` that returns the MCP read-result wrapper. The runtime
    // maps the return INTO `contents`, so this shape must fail loudly, not become contents[0].text =
    // '{"contents":[...]}'. Guards both the bare object and the `{ value }`-wrapped forms.
    const wrapper = {
      contents: [{ uri: 'docs://x', mimeType: 'text/markdown', text: '# X' }],
    };
    expect(() => mapResourceContents('docs://x', 'text/markdown', { value: wrapper })).toThrow(
      /contents: \[/,
    );
    expect(() => mapResourceContents('docs://x', 'text/markdown', wrapper)).toThrow(
      /bare content entry/,
    );
  });

  it('leaves a plain data object with a non-array `contents` field JSON-serialized', () => {
    // Only the `contents: [...]` array wrapper is the double-wrap mistake; a document whose data
    // happens to carry a scalar `contents` field is legitimate and still JSON-serialized.
    expect(
      mapResourceContents('data://x', undefined, { value: { title: 'Doc', contents: 'body' } }),
    ).toEqual({
      contents: [{ uri: 'data://x', text: '{"title":"Doc","contents":"body"}' }],
    });
  });
});

describe('mapPromptMessages', () => {
  it('maps a string value to one user text message and keeps the prompt description', () => {
    expect(mapPromptMessages({ value: 'Triage ticket' }, 'Prompt description')).toEqual({
      description: 'Prompt description',
      messages: [{ role: 'user', content: { type: 'text', text: 'Triage ticket' } }],
    });
  });

  it('maps a text object to one user text message', () => {
    expect(mapPromptMessages({ value: { text: 'Summarize this' } })).toEqual({
      messages: [{ role: 'user', content: { type: 'text', text: 'Summarize this' } }],
    });
  });

  it('normalizes arrays of role/text prompt messages', () => {
    expect(
      mapPromptMessages({
        value: [
          { role: 'assistant', text: 'I can help.' },
          { role: 'user', text: 'Use this ticket.' },
        ],
      }),
    ).toEqual({
      messages: [
        { role: 'assistant', content: { type: 'text', text: 'I can help.' } },
        { role: 'user', content: { type: 'text', text: 'Use this ticket.' } },
      ],
    });
  });

  it('normalizes wire-shaped messages under a messages field', () => {
    expect(
      mapPromptMessages({
        value: {
          messages: [{ role: 'assistant', content: { type: 'text', text: 'Already shaped.' } }],
        },
      }),
    ).toEqual({
      messages: [{ role: 'assistant', content: { type: 'text', text: 'Already shaped.' } }],
    });
  });

  it('falls back to JSON text for unsupported values', () => {
    expect(mapPromptMessages({ value: { ok: true } })).toEqual({
      messages: [{ role: 'user', content: { type: 'text', text: '{"ok":true}' } }],
    });
  });
});
