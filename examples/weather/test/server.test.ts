import { describe, expect, it } from 'vitest';
import app from '../src/server.js';

describe('weather example', () => {
  it('exports a Noodle server definition', () => {
    expect(typeof app.toManifest).toBe('function');
  });

  it('adds a list-returning search_places tool without disturbing tool order', async () => {
    const manifest = (await app.toManifest()) as {
      tools: ReadonlyArray<{ name: string }>;
      connectors?: Record<string, { id: string; version: string }>;
    };
    const toolNames = manifest.tools.map((t) => t.name);
    // The original briefing tool stays first — host harnesses (the online e2e) read `tools[0]`,
    // so new tools are appended, never prepended.
    expect(toolNames[0]).toBe('weather_briefing');
    expect(toolNames).toContain('search_places');
    expect(toolNames.indexOf('search_places')).toBeGreaterThan(
      toolNames.indexOf('weather_briefing'),
    );
    // The list is produced by a whole-array-bind HTTP op (`search_list`) narrowed to {id,label}
    // through a separate compute connector (`geo_places`).
    expect(manifest.connectors?.places).toEqual({ id: 'geo_places', version: '1.0.0' });
    const wire = JSON.stringify(manifest);
    expect(wire).toContain('search_list');
    expect(wire).toContain('narrow');
  });

  it('demonstrates an explicit least-privilege response-size bound', () => {
    const catalog = app.toConnectorCatalog();
    const geocoding = catalog?.connectors.find(
      (candidate) => candidate.id === 'open_meteo_geocoding',
    );

    expect(geocoding?.operations.search_list?.limits).toEqual({
      maxResponseBytes: 256 * 1024,
    });
  });
});
