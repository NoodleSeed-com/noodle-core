import { describe, expect, it } from 'vitest';
import { embeddedAssistant, noodleManaged, publicMessaging, publicWebsite } from '../src/index.js';

const capabilities = [{ kind: 'knowledge' as const, name: 'product' }];

describe('public messaging authoring', () => {
  it('keeps messaging separate from the website origin and audience selectors', () => {
    const assistant = embeddedAssistant({
      model: noodleManaged(),
      access: [
        publicMessaging({ channel: 'whatsapp', capabilities }),
        publicWebsite({ origins: ['https://acme.test'], capabilities }),
      ],
    });
    expect(assistant.allowedOrigins).toEqual(['https://acme.test']);
    expect(assistant.surfaces[0]).toEqual({
      kind: 'messaging',
      channel: 'whatsapp',
      mode: 'public',
      capabilities,
    });
  });

  it('permits a messaging-only application without inventing a browser origin', () => {
    const assistant = embeddedAssistant({
      model: noodleManaged(),
      access: publicMessaging({ channel: 'whatsapp', capabilities }),
    });
    expect(assistant.allowedOrigins).toEqual([]);
  });

  it('rejects duplicate channel declarations', () => {
    const surface = publicMessaging({ channel: 'whatsapp', capabilities });
    expect(() => embeddedAssistant({ model: noodleManaged(), access: [surface, surface] })).toThrow(
      /one.*whatsapp|duplicate.*whatsapp/i,
    );
  });

  it('rejects browser-only properties and absent capability declarations at runtime', () => {
    expect(() => Reflect.apply(publicMessaging, undefined, [{ channel: 'whatsapp' }])).toThrow(
      /capabilit/i,
    );
    expect(() =>
      Reflect.apply(publicMessaging, undefined, [
        {
          channel: 'whatsapp',
          capabilities,
          origins: ['https://acme.test'],
        },
      ]),
    ).toThrow(/origins|unknown/i);
  });
});
