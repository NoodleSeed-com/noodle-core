import { requiresToolConfirmation } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import assistantSmokeServer from '../../../scripts/e2e/fixtures/embedded-assistant/server.js';
import {
  assertSessionContract,
  parseArgs,
  parseAssistantEvents,
  parseCreatedClient,
} from '../../../scripts/embedded-assistant-remote-smoke.mjs';

describe('embedded assistant remote smoke contract', () => {
  it('uses a stable private smoke target by default', () => {
    expect(parseArgs(['--service', 'https://dev.example'])).toMatchObject({
      org: 'pipeline',
      app: 'embedded-assistant-smoke',
      env: 'prod',
    });
  });
  it('parses assistant SSE without retaining credentials', () => {
    expect(parseAssistantEvents('event: content\ndata: {"delta":"ok"}\n\n')).toEqual([
      { event: 'content', data: { delta: 'ok' } },
    ]);
  });

  it('reads client credentials from the standard CLI JSON envelope', () => {
    expect(
      parseCreatedClient(
        JSON.stringify({
          ok: true,
          data: {
            id: 'embed_123',
            secretFile: '/tmp/assistant-client.json',
          },
        }),
      ),
    ).toEqual({ id: 'embed_123', secretFile: '/tmp/assistant-client.json' });
  });

  it("requires the write tool only for the smoke's explicit update request", async () => {
    const manifest = await assistantSmokeServer.toManifest();
    const updateNote = manifest.tools.find((tool) => tool.name === 'update_note');

    expect(updateNote?.annotations).toMatchObject({
      'x-noodleseed-model-latest-message-includes-any': ['Call update_note'],
      'x-noodleseed-model-required-when-visible': true,
    });
  });

  // The smoke drives `update_note` through the confirmation path: it asserts a `tool_proposed`
  // event, accepts it, replays it, and expects a fresh proposal after a redeploy. The gateway only
  // suspends when `requiresToolConfirmation` holds, so a fixture that reaches the model
  // deterministically but never opts into confirmation still fails the whole smoke over the wire,
  // with no local signal.
  it('gates that write tool behind an explicit confirmation', async () => {
    const manifest = await assistantSmokeServer.toManifest();
    const updateNote = manifest.tools.find((tool) => tool.name === 'update_note');

    expect(requiresToolConfirmation(updateNote?.annotations)).toBe(true);
  });
});

describe('assertSessionContract (ADR 0151 over-the-wire gate)', () => {
  const goldenFixture = {
    token: 'nss_x',
    expiresAt: '2026-01-01T00:00:00Z',
    endpoints: {
      turns: 'https://x/v1/assistant/turns',
      toolConfirmations: 'https://x/v1/assistant/tool-confirmations',
      interactions: 'https://x/v1/assistant/interactions',
    },
    configuration: {},
  };

  it('accepts a conforming response, with configuration optional', () => {
    expect(() =>
      assertSessionContract(
        {
          token: 't',
          expiresAt: 'e',
          endpoints: { turns: 'a', toolConfirmations: 'b', interactions: 'c' },
        },
        goldenFixture,
      ),
    ).not.toThrow();
  });

  it('requires the modern interactions endpoint in the deployed service smoke', () => {
    expect(() =>
      assertSessionContract(
        { token: 't', expiresAt: 'e', endpoints: { turns: 'a', toolConfirmations: 'b' } },
        goldenFixture,
      ),
    ).toThrow(/session endpoints/);
  });

  it('rejects a response missing endpoints (the 1.0.0-era gatewayUrl shape)', () => {
    expect(() =>
      assertSessionContract({ token: 't', expiresAt: 'e', gatewayUrl: 'https://x' }, goldenFixture),
    ).toThrow(/missing required field "endpoints"/);
  });

  it('rejects an additive field that skipped the contract fixture', () => {
    expect(() =>
      assertSessionContract(
        {
          token: 't',
          expiresAt: 'e',
          endpoints: { turns: 'a', toolConfirmations: 'b' },
          surprise: true,
        },
        goldenFixture,
      ),
    ).toThrow(/update the contract fixture/);
  });
});
