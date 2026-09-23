import { describe, expect, it } from 'vitest';
import {
  authenticatedWebsite,
  embeddedAssistant,
  noodleManaged,
  publicMessaging,
  publicWebsite,
} from '../src/index.js';

/**
 * A surface may declare that it never keeps chats (ADR 0241 decision 11). Only the literal `false` is
 * accepted: how many days a recorded surface keeps is the business's setting (ADR 0212), never code.
 */
const capabilities = [{ kind: 'knowledge' as const, name: 'product' }];

describe('history: false surface declaration', () => {
  it('carries history: false on every surface kind into the compiled assistant', () => {
    const assistant = embeddedAssistant({
      model: noodleManaged(),
      access: [
        publicWebsite({ origins: ['https://acme.test'], capabilities, history: false }),
        authenticatedWebsite({ origins: ['https://app.acme.test'], history: false }),
        publicMessaging({ channel: 'whatsapp', capabilities, history: false }),
      ],
    });
    expect(assistant.surfaces.map((surface) => surface.history)).toEqual([false, false, false]);
  });

  it('adds nothing when a surface stays silent, so recording follows the business setting', () => {
    const assistant = embeddedAssistant({
      model: noodleManaged(),
      access: [
        publicWebsite({ origins: ['https://acme.test'], capabilities }),
        authenticatedWebsite({ origins: ['https://app.acme.test'] }),
        publicMessaging({ channel: 'whatsapp', capabilities }),
      ],
    });
    for (const surface of assistant.surfaces) expect('history' in surface).toBe(false);
  });

  it('refuses true and a number of days with an error naming where days are set', () => {
    for (const value of [true, 30, 0, 'off'] as unknown[]) {
      // A runtime guard for untyped callers, so the wrong values are passed on purpose.
      for (const build of [
        () =>
          publicWebsite({ origins: ['https://acme.test'], capabilities, history: value as false }),
        () => authenticatedWebsite({ origins: ['https://app.acme.test'], history: value as false }),
        () => publicMessaging({ channel: 'whatsapp', capabilities, history: value as false }),
      ] as const) {
        expect(build).toThrow(/history accepts only false.*noodle solutions history settings/);
      }
    }
  });
});
