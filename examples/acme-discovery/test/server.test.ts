import { describe, expect, it } from 'vitest';
import app from '../src/server.js';

describe('acme-discovery example', () => {
  it('exports a Noodle server definition', () => {
    expect(typeof app.toManifest).toBe('function');
  });

  it('declares the off-app handoff domain the deep link lands on', async () => {
    // Top-of-funnel: the only external target is Acme's booking site, declared once at the server.
    const manifest = await app.toManifest();
    expect(JSON.stringify(manifest)).toContain('https://book.acme.example');
  });

  it('exposes the discovery tool and the handoff tool', async () => {
    const manifest = await app.toManifest();
    const text = JSON.stringify(manifest);
    // The discovery tool renders the carousel; the handoff tool emits the deep link; the widget-only
    // helper records a shortlist.
    expect(text).toContain('discover_getaways');
    expect(text).toContain('create_handoff');
    expect(text).toContain('shortlist_getaway');
  });

  it('gives the public website a consultative surface-specific goal', async () => {
    const manifest = await app.toManifest();
    expect(manifest.server.assistant?.model).toEqual({ kind: 'noodle-managed' });
    expect(manifest.server.assistant?.surfaces?.[0]?.instructions).toContain(
      'friendly, consultative travel guide',
    );
  });

  it('keeps the lead capture behind explicit confirmation and a managed customer sink', async () => {
    const manifest = (await app.toManifest()) as {
      tools: { name: string; annotations?: Record<string, unknown> }[];
    };
    const captureLead = manifest.tools.find((tool) => tool.name === 'capture_lead');
    // The confirmation card is the visitor's consent moment (ADR 0214): a lead may never leave the
    // conversation without it, and the sink endpoint/credential stay operator-managed data.
    expect(captureLead?.annotations?.confirm).toBe(true);
    const catalog = JSON.stringify(
      (app as unknown as { toConnectorCatalog: () => unknown }).toConnectorCatalog(),
    );
    expect(catalog).toContain('${env.LEAD_SINK_URL}');
    expect(catalog).toContain('LEAD_SINK_TOKEN');
    // Fixed attribution set in the request mapping, never model-supplied; no named vendor host.
    expect(catalog).toContain('website-assistant');
    expect(catalog).not.toContain('api.resend.com');
    expect(catalog).not.toContain('api.hubapi.com');
  });

  it('serves a mixed marketing surface and an authenticated account surface from one server', async () => {
    const manifest = await app.toManifest();
    const surfaces = manifest.server.assistant?.surfaces ?? [];
    expect(surfaces.map((surface) => surface.mode)).toEqual(['mixed', 'authenticated']);
    // The sign-in trigger is listed on the mixed surface so the assistant can offer it; the
    // authenticated surface carries its own narrowed list and voice.
    const capabilityNames = (surface: (typeof surfaces)[number]) =>
      surface.capabilities?.map((capability) => capability.name) ?? [];
    expect(capabilityNames(surfaces[0]!)).toContain('my_trips');
    expect(capabilityNames(surfaces[0]!)).toContain('capture_lead');
    expect(capabilityNames(surfaces[1]!)).toEqual([
      'destinations',
      'discover_getaways',
      'create_handoff',
      'my_trips',
    ]);
    // Authoring the sign-up label is the opt-in for the card's create-account button.
    expect(manifest.server.assistant?.labels?.signUpAction).toBe('Create free account');
  });

  it('opens the marketing surface to browser agents and leaves the account surface closed', async () => {
    const manifest = await app.toManifest();
    const surfaces = manifest.server.assistant?.surfaces ?? [];

    // Both front doors, asserted by count first: without it the per-surface claims below read a
    // missing surface as `undefined` and pass, so deleting a surface would silently satisfy them.
    expect(surfaces).toHaveLength(2);
    // ADR 0220: the opt-in governs *discovery* — whether the embed registers this session's already
    // projected tools with `document.modelContext`. A browser agent on Acme's marketing page reaches
    // exactly the six capabilities above, over the same authorization, confirmation, and budget path
    // the panel's own calls take. `capture_lead` still stops for its confirmation card.
    expect(surfaces[0]?.webmcp).toEqual({ enabled: true });
    // Per-surface opt-in exists so the two front doors can answer differently, and here they do: the
    // signed-in account surface carries a traveler's identity, so its tools are not advertised to
    // whatever agent happens to be running in that browser.
    expect(surfaces[1]?.webmcp).toBeUndefined();
  });

  it('declares the grounded knowledge component and its live site scope', async () => {
    const manifest = (await app.toManifest()) as { server: { knowledge?: unknown[] } };
    // One declaration: controlled files plus the live public site, compiled later into the
    // generated `search_destinations` capability with citations.
    expect(manifest.server.knowledge).toHaveLength(1);
    const text = JSON.stringify(manifest);
    expect(text).toContain('knowledge/product.md');
    expect(text).toContain('https://getaways.acme.example');
  });
});
