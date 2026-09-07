import { MCP_APP_MIME_TYPE, type RuntimeArtifact } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { projectArtifactForSurface } from '../src/artifact-projection.js';

const tool = (name: string, resourceUri?: string) => ({
  name,
  description: name,
  inputSchema: { type: 'object' as const },
  fulfilment: { kind: 'flow' as const, steps: [] },
  ...(resourceUri ? { _meta: { ui: { resourceUri } } } : {}),
});

const ARTIFACT = {
  artifactSchemaVersion: '0.15.0',
  resolution: 'resolved',
  source: { manifestName: 'acme', manifestVersion: '2', coreVersion: '2' },
  server: { name: 'acme', title: 'Acme', version: '1.0.0' },
  capabilities: { tools: [] },
  tools: [
    tool('ask_product', 'ui://acme/product-card'),
    tool('request_demo'),
    tool('internal_audit', 'ui://acme/audit-panel'),
  ],
  resources: [
    { uri: 'ui://acme/product-card', mimeType: MCP_APP_MIME_TYPE, fulfilment: { kind: 'flow' } },
    { uri: 'ui://acme/audit-panel', mimeType: MCP_APP_MIME_TYPE, fulfilment: { kind: 'flow' } },
    { uri: 'data://acme/pricing', mimeType: 'application/json', fulfilment: { kind: 'flow' } },
  ],
} as unknown as RuntimeArtifact;

const PUBLIC_TWO = [
  { kind: 'tool' as const, name: 'ask_product' },
  { kind: 'tool' as const, name: 'request_demo' },
];

describe('artifact projection for a public surface', () => {
  it('keeps only the tools the author selected for this surface', () => {
    const projected = projectArtifactForSurface(ARTIFACT, PUBLIC_TWO);
    expect(projected.tools.map((t) => t.name)).toEqual(['ask_product', 'request_demo']);
  });

  /**
   * The point of projecting the artifact rather than filtering each reader: an unlisted tool is not
   * merely hidden from `tools/list`, it is *absent*. Every `artifact.tools.find(...)` in the interaction
   * and execution paths therefore misses it without knowing projection exists — which is the runtime
   * backstop for a `callServerTool` target or elicitation path the compiler could not close over.
   */
  it('makes an unlisted tool unfindable, not merely unlisted', () => {
    const projected = projectArtifactForSurface(ARTIFACT, PUBLIC_TWO);
    expect(projected.tools.find((t) => t.name === 'internal_audit')).toBeUndefined();
  });

  it('drops a widget whose only tool was dropped', () => {
    const projected = projectArtifactForSurface(ARTIFACT, PUBLIC_TWO);
    const uris = (projected.resources ?? []).map((r) => r.uri);

    expect(uris).toContain('ui://acme/product-card');
    // The audit panel is reachable only through `internal_audit`, which this surface does not offer.
    expect(uris).not.toContain('ui://acme/audit-panel');
  });

  /**
   * Closes the live defect: `resources/list` and `resources/read` applied no caller filter at all, so any
   * artifact URI was readable by any session. A resource survives only by being linked from a surviving
   * tool, so an unreferenced data resource is not public by default.
   */
  it('drops a resource no surviving tool links to', () => {
    const projected = projectArtifactForSurface(ARTIFACT, PUBLIC_TWO);
    expect((projected.resources ?? []).map((r) => r.uri)).not.toContain('data://acme/pricing');
  });

  it('projects nothing away when the surface selects everything', () => {
    const all = ARTIFACT.tools.map((t) => ({ kind: 'tool' as const, name: t.name }));
    const projected = projectArtifactForSurface(ARTIFACT, all);

    expect(projected.tools).toHaveLength(3);
    expect(projected.resources).toHaveLength(2);
  });

  it('yields an empty surface rather than the whole artifact when nothing is selected', () => {
    const projected = projectArtifactForSurface(ARTIFACT, []);
    // Fail closed: an empty capability list is "offer nothing", never "offer everything".
    expect(projected.tools).toEqual([]);
    expect(projected.resources).toEqual([]);
  });

  it('ignores a capability naming a tool that no longer exists', () => {
    const projected = projectArtifactForSurface(ARTIFACT, [
      { kind: 'tool', name: 'ask_product' },
      { kind: 'tool', name: 'deleted_tool' },
    ]);
    expect(projected.tools.map((t) => t.name)).toEqual(['ask_product']);
  });

  it('leaves everything outside tools and resources untouched', () => {
    const projected = projectArtifactForSurface(ARTIFACT, PUBLIC_TWO);
    expect(projected.server).toEqual(ARTIFACT.server);
    expect(projected.source).toEqual(ARTIFACT.source);
  });

  it('does not mutate the served artifact', () => {
    projectArtifactForSurface(ARTIFACT, []);
    // The registry hands out one shared artifact per deployment; projecting must never scribble on it.
    expect(ARTIFACT.tools).toHaveLength(3);
    expect(ARTIFACT.resources).toHaveLength(3);
  });
});

describe('knowledge capability projection', () => {
  const knowledgeComponent = (name: string) => ({
    name,
    title: `${name} knowledge`,
    description: `${name} knowledge.`,
    documents: [],
    sites: [],
    generatedTool: {
      name: `search_${name}`,
      description: 'generated',
      inputSchema: {},
      outputSchema: {},
    },
  });
  const WITH_KNOWLEDGE = {
    ...ARTIFACT,
    server: {
      ...ARTIFACT.server,
      knowledge: [knowledgeComponent('product'), knowledgeComponent('internal')],
    },
  } as unknown as RuntimeArtifact;

  it('keeps only allowlisted knowledge components', () => {
    const projected = projectArtifactForSurface(WITH_KNOWLEDGE, [
      { kind: 'tool', name: 'ask_product' },
      { kind: 'knowledge', name: 'product' },
    ]);
    expect(projected.server.knowledge?.map((component) => component.name)).toEqual(['product']);
  });

  it('fails closed: no knowledge capability means no knowledge components', () => {
    const projected = projectArtifactForSurface(WITH_KNOWLEDGE, PUBLIC_TWO);
    expect(projected.server.knowledge ?? []).toHaveLength(0);
  });
});
