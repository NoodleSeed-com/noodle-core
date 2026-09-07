import { describe, expect, it } from 'vitest';
import app from '../src/server.js';

describe('acme-bistro example', () => {
  it('exports a Noodle server definition', () => {
    expect(typeof app.toManifest).toBe('function');
  });

  it('declares the payment-only handoff domain', async () => {
    // End-to-end: the order completes in chat; only payment hands off to Acme's checkout.
    const text = JSON.stringify(await app.toManifest());
    expect(text).toContain('https://pay.acme.example');
  });

  it('exposes the menu widget, cart helpers, and checkout tool', async () => {
    const text = JSON.stringify(await app.toManifest());
    expect(text).toContain('show_menu');
    expect(text).toContain('add_to_cart');
    expect(text).toContain('create_checkout');
  });

  it('declares guest records and explicitly authors the native submission tool', async () => {
    const manifest = await app.toManifest();
    expect(manifest.server.collections).toEqual([
      expect.objectContaining({ name: 'guest_requests', schemaVersion: 1 }),
    ]);
    expect(
      manifest.tools.find((tool) => tool.name === 'submit_guest_request')?.fulfilment.steps,
    ).toMatchObject([{ use: 'records.submit_record' }]);
  });
});
