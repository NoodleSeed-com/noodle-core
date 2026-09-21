import { describe, expect, it } from 'vitest';
import { InMemoryCatalog } from '../src/catalog/in-memory.js';
import { compileManifest } from '../src/compile.js';
import { BUILTIN_RECORD_CATALOG_CONNECTOR } from '../src/native-record-operations.js';

/**
 * The `collect` interaction block (ADR 0240) is bounded metadata on an opener tool: which fields the
 * platform renderer collects for a confirmed action, which are private, and what to say on success.
 * The compiler freezes its spelling, checks every field against the action's input schema, and emits
 * it as a system-owned artifact section keyed by the opener, never as MCP-visible `_meta`.
 */

const catalog = new InMemoryCatalog([BUILTIN_RECORD_CATALOG_CONNECTOR]);

const brief = {
  type: 'object',
  properties: {
    workflow: { type: 'string', minLength: 10, maxLength: 240 },
    demandSignal: { type: 'string', enum: ['Move to production', 'Reach more customers'] },
  },
  required: ['workflow', 'demandSignal'],
  additionalProperties: false,
};

const enquiry = {
  type: 'object',
  properties: {
    ...brief.properties,
    fullName: { type: 'string', minLength: 2, maxLength: 120 },
    workEmail: { type: 'string', format: 'email', maxLength: 240 },
    website: { type: 'string', maxLength: 240, pattern: '^(?:|https?:\\/\\/[^\\s]+)$' },
    consentToContact: { type: 'boolean', const: true },
    note: { type: 'string', maxLength: 240 },
  },
  required: ['workflow', 'demandSignal', 'fullName', 'workEmail', 'website', 'consentToContact'],
  additionalProperties: false,
};

const collect = {
  kind: 'collect',
  action: 'submit_enquiry',
  initialValues: {
    workflow: { fromOutput: 'workflow' },
    demandSignal: { fromOutput: 'demandSignal' },
  },
  fields: [
    { key: 'fullName', control: 'text' },
    { key: 'workEmail', control: 'email', private: true },
    { key: 'website', control: 'url', optional: true },
    { key: 'demandSignal', control: 'select' },
    { key: 'consentToContact', control: 'consent' },
  ],
  review: 'all',
  outcome: { success: 'Your enquiry was saved.' },
};

interface Overrides {
  readonly interaction?: unknown;
  readonly openerOutput?: unknown;
  readonly actionInput?: unknown;
  readonly actionAnnotations?: Record<string, unknown>;
}

function manifest(overrides: Overrides = {}): unknown {
  return {
    manifestVersion: '2',
    server: { name: 'acme_site', title: 'Acme Site', version: '1.0.0' },
    connectors: { records: { id: 'noodle_records', version: '1.0.0' } },
    tools: [
      {
        name: 'open_contact_form',
        description: 'Open the enquiry.',
        inputSchema: brief,
        ...('openerOutput' in overrides
          ? { outputSchema: overrides.openerOutput }
          : { outputSchema: brief }),
        annotations: { readOnlyHint: true },
        fulfilment: {
          steps: [],
          output: { workflow: '${input.workflow}', demandSignal: '${input.demandSignal}' },
        },
        interaction: 'interaction' in overrides ? overrides.interaction : collect,
      },
      {
        name: 'submit_enquiry',
        description: 'Save the reviewed enquiry.',
        inputSchema: overrides.actionInput ?? enquiry,
        outputSchema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
        annotations: overrides.actionAnnotations ?? { readOnlyHint: false, confirm: true },
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
    ],
  };
}

function compile(input: unknown) {
  return compileManifest(input, { catalog });
}

function errorsOf(input: unknown): readonly { code: string; path: string; message: string }[] {
  const result = compile(input);
  return result.ok ? [] : result.errors;
}

function codes(input: unknown): readonly string[] {
  return errorsOf(input).map((error) => error.code);
}

describe('collect interaction emission', () => {
  it('emits the block under artifact.toolInteractions keyed by the opener, action by name', () => {
    const result = compile(manifest());
    expect(result.ok, JSON.stringify(errorsOf(manifest()))).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.toolInteractions).toEqual({
      open_contact_form: {
        kind: 'collect',
        action: 'submit_enquiry',
        initialValues: collect.initialValues,
        fields: collect.fields,
        review: 'all',
        outcome: { success: 'Your enquiry was saved.' },
      },
    });
  });

  it('keeps the MCP-visible tool descriptor free of interaction metadata', () => {
    const result = compile(manifest());
    if (!result.ok) throw new Error('expected ok');
    const opener = result.artifact.tools.find((tool) => tool.name === 'open_contact_form');
    expect(opener).toBeDefined();
    expect(Object.keys(opener ?? {})).not.toContain('interaction');
    expect(opener?._meta).toBeUndefined();
  });

  it('omits the section entirely when no tool declares an interaction', () => {
    const result = compile(manifest({ interaction: undefined }));
    if (!result.ok) throw new Error('expected ok');
    expect(result.artifact.toolInteractions).toBeUndefined();
    expect(Object.keys(result.artifact)).not.toContain('toolInteractions');
  });

  it('flattens a shortened confirmation expiry to seconds', () => {
    const result = compile(
      manifest({ interaction: { ...collect, confirmationExpiry: { seconds: 600 } } }),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.artifact.toolInteractions?.open_contact_form?.confirmationExpirySeconds).toBe(
      600,
    );
  });

  it('compiles shape-only without a catalog', () => {
    const result = compileManifest(manifest());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.toolInteractions?.open_contact_form?.action).toBe('submit_enquiry');
  });
});

describe('collect interaction spelling is frozen', () => {
  it.each([
    ['an unknown top-level property', { ...collect, layout: 'stacked' }],
    [
      'an unknown field property',
      { ...collect, fields: [{ key: 'fullName', control: 'text', label: 'Name' }] },
    ],
    ['an unknown control', { ...collect, fields: [{ key: 'fullName', control: 'checkbox' }] }],
    ['a kind other than collect', { ...collect, kind: 'choose' }],
    ['a review mode other than all', { ...collect, review: 'summary' }],
    [
      'private set to false',
      { ...collect, fields: [{ key: 'fullName', control: 'text', private: false }] },
    ],
    [
      'a duplicate field key',
      { ...collect, fields: [...collect.fields, { key: 'fullName', control: 'text' }] },
    ],
    ['an empty field list', { ...collect, fields: [] }],
    ['an empty success outcome', { ...collect, outcome: { success: '   ' } }],
  ])('rejects %s as a shape error', (_label, interaction) => {
    const result = compile(manifest({ interaction }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.every((error) => error.code === 'invalid_shape')).toBe(true);
    expect(result.errors[0]?.path.startsWith('tools.0.interaction')).toBe(true);
  });
});

describe('collect interaction validation', () => {
  it('rejects an action that is not a declared tool', () => {
    const errors = errorsOf(manifest({ interaction: { ...collect, action: 'ghost' } }));
    expect(errors.map((error) => error.code)).toEqual(['interaction_action_invalid']);
    expect(errors[0]?.path).toBe('tools.0.interaction.action');
    expect(errors[0]?.message).toContain('ghost');
  });

  it('rejects an action without exact confirmation or marked read-only', () => {
    expect(codes(manifest({ actionAnnotations: { readOnlyHint: false } }))).toContain(
      'interaction_action_invalid',
    );
    expect(codes(manifest({ actionAnnotations: { readOnlyHint: true, confirm: true } }))).toContain(
      'interaction_action_invalid',
    );
  });

  it('rejects a field that is not an action input property', () => {
    const errors = errorsOf(
      manifest({
        interaction: {
          ...collect,
          fields: [...collect.fields, { key: 'nickname', control: 'text' }],
        },
      }),
    );
    expect(errors.map((error) => error.code)).toEqual(['interaction_field_unknown']);
    expect(errors[0]?.path).toBe('tools.0.interaction.fields.5');
  });

  it.each([
    ['consent on a string', { key: 'fullName', control: 'consent' }],
    ['select on a non-enum', { key: 'fullName', control: 'select' }],
    ['email on a boolean', { key: 'consentToContact', control: 'email' }],
    ['text on a boolean', { key: 'consentToContact', control: 'text' }],
    ['url on a boolean', { key: 'consentToContact', control: 'url' }],
  ])('rejects %s as a control mismatch', (_label, field) => {
    const fields = collect.fields.filter((entry) => entry.key !== field.key);
    const codesSeen = codes(manifest({ interaction: { ...collect, fields: [...fields, field] } }));
    expect(codesSeen).toContain('interaction_field_control_mismatch');
  });

  it('accepts consent on an enum:[true] boolean', () => {
    const actionInput = {
      ...enquiry,
      properties: { ...enquiry.properties, consentToContact: { type: 'boolean', enum: [true] } },
    };
    expect(codes(manifest({ actionInput }))).toEqual([]);
  });

  it('rejects a required action input that is neither a field nor an initial value', () => {
    const fields = collect.fields.filter((entry) => entry.key !== 'fullName');
    const errors = errorsOf(manifest({ interaction: { ...collect, fields } }));
    expect(errors.map((error) => error.code)).toEqual(['interaction_field_missing']);
    expect(errors[0]?.message).toContain('fullName');
  });

  it('rejects a non-optional field whose property is not required', () => {
    const fields = [...collect.fields, { key: 'note', control: 'text' }];
    expect(codes(manifest({ interaction: { ...collect, fields } }))).toEqual([
      'interaction_field_missing',
    ]);
    const optional = [...collect.fields, { key: 'note', control: 'textarea', optional: true }];
    expect(codes(manifest({ interaction: { ...collect, fields: optional } }))).toEqual([]);
  });

  it('lets an optional field stay required only when its string schema accepts the empty value', () => {
    // The flagship represents an omitted website as "" rather than an `anyOf` union, so the renderer
    // submits "" for an optional field the schema still requires. That is sound only when "" is valid.
    const rejectsEmpty = {
      ...enquiry,
      properties: { ...enquiry.properties, website: { type: 'string', minLength: 1 } },
    };
    expect(codes(manifest({ actionInput: rejectsEmpty }))).toEqual(['interaction_field_missing']);
    const patternRejectsEmpty = {
      ...enquiry,
      properties: { ...enquiry.properties, website: { type: 'string', pattern: '^https://' } },
    };
    expect(codes(manifest({ actionInput: patternRejectsEmpty }))).toEqual([
      'interaction_field_missing',
    ]);
    const notRequired = {
      ...enquiry,
      required: enquiry.required.filter((key) => key !== 'website'),
    };
    expect(codes(manifest({ actionInput: notRequired }))).toEqual([]);
  });

  it('rejects an initial value from an unknown opener output or onto an unknown action input', () => {
    expect(
      codes(
        manifest({
          interaction: {
            ...collect,
            initialValues: { ...collect.initialValues, workflow: { fromOutput: 'nope' } },
          },
        }),
      ),
    ).toEqual(['interaction_initial_value_unknown']);
    expect(
      codes(
        manifest({
          interaction: {
            ...collect,
            initialValues: { ...collect.initialValues, nope: { fromOutput: 'workflow' } },
          },
        }),
      ),
    ).toEqual(['interaction_initial_value_unknown']);
    // An opener without an output schema can seed nothing.
    expect(codes(manifest({ openerOutput: undefined }))).toEqual([
      'interaction_initial_value_unknown',
      'interaction_initial_value_unknown',
    ]);
  });

  it('rejects more than one consent field', () => {
    const actionInput = {
      ...enquiry,
      properties: { ...enquiry.properties, consentToTerms: { type: 'boolean', const: true } },
      required: [...enquiry.required, 'consentToTerms'],
    };
    const fields = [...collect.fields, { key: 'consentToTerms', control: 'consent' }];
    expect(codes(manifest({ actionInput, interaction: { ...collect, fields } }))).toEqual([
      'interaction_consent_invalid',
    ]);
  });

  it.each([0, -5, 1.5, 86_401])('rejects a confirmation expiry of %s seconds', (seconds) => {
    const errors = errorsOf(
      manifest({ interaction: { ...collect, confirmationExpiry: { seconds } } }),
    );
    expect(errors.map((error) => error.code)).toEqual(['interaction_expiry_invalid']);
    expect(errors[0]?.path).toBe('tools.0.interaction.confirmationExpiry.seconds');
  });

  it('accepts the 24-hour platform ceiling exactly', () => {
    expect(
      codes(manifest({ interaction: { ...collect, confirmationExpiry: { seconds: 86_400 } } })),
    ).toEqual([]);
  });
});
