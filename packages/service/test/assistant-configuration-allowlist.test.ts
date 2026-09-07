import { assistantBrowserConfiguration } from '@noodle-borg/assistant-gateway/portable';
import { describe, expect, it } from 'vitest';

/**
 * The session response's `configuration` is handed to the browser, and its wire schema is
 * `z.record(z.unknown())` — it validates nothing. Forwarding "everything except model and origins" was
 * therefore a standing leak: it already shipped `sessionClaims` **key names** to every embed, and with
 * ADR 0201 it would ship a public page the server's internal capability allowlist.
 *
 * An explicit allowlist inverts the default. A field reaches the browser because someone named it here,
 * not because nobody remembered to remove it.
 */
describe('assistant browser configuration allowlist', () => {
  const uiFields = {
    theme: 'invert' as const,
    layout: { mode: 'floating' as const },
    behavior: { startOpen: true, showConfirmationDetails: false },
    labels: { welcomeHeading: 'Hi' },
    presentation: { panel: { surface: 'solid' as const } },
    suggestedPrompts: ['Ask me'],
    privacyUrl: 'https://acme.test/privacy',
    termsUrl: 'https://acme.test/terms',
    locale: 'en-GB',
    direction: 'ltr' as const,
  };

  it('forwards the branding and UI fields the widget renders', () => {
    const configuration = assistantBrowserConfiguration({
      branding: { name: 'Acme' },
      assistant: { ...uiFields },
    } as never);

    expect(configuration).toEqual({ branding: { name: 'Acme' }, assistant: uiFields });
  });

  it('never forwards credentials, origins, claims, surfaces, or capabilities', () => {
    const configuration = assistantBrowserConfiguration({
      assistant: {
        ...uiFields,
        model: { kind: 'openai-compatible', baseUrl: 'https://m.test', apiKey: 'MODEL_KEY' },
        allowedOrigins: ['https://www.acme.test'],
        sessionClaims: { plan: { exposeToModel: true } },
        surfaces: [
          {
            mode: 'public',
            origins: ['https://www.acme.test'],
            capabilities: [{ kind: 'tool', name: 'internal_audit' }],
          },
        ],
      },
    } as never);

    const serialized = JSON.stringify(configuration);
    for (const secretish of [
      'MODEL_KEY',
      'apiKey',
      'allowedOrigins',
      'sessionClaims',
      'plan',
      'surfaces',
      'capabilities',
      'internal_audit',
    ]) {
      expect(serialized).not.toContain(secretish);
    }
  });

  it('drops a field added to the manifest later until someone allowlists it', () => {
    const configuration = assistantBrowserConfiguration({
      assistant: { labels: { welcomeHeading: 'Hi' }, somethingNewAndInternal: 'leak' },
    } as never);

    // Fail-closed: growth in the manifest does not silently grow the browser payload.
    expect(JSON.stringify(configuration)).not.toContain('somethingNewAndInternal');
    expect(configuration).toEqual({ assistant: { labels: { welcomeHeading: 'Hi' } } });
  });

  it('omits configuration entirely when no assistant or branding is declared', () => {
    expect(assistantBrowserConfiguration({} as never)).toBeUndefined();
  });
});

/**
 * `webmcp` (ADR 0220, amended) is the assistant's default and the session's own surface may override
 * it either way. It governs discovery — whether the embed registers this session's tools with
 * `document.modelContext` — so the value that reaches the browser has to be the one for the surface
 * this session was actually minted on, not the deployment's average.
 *
 * The allowlist itself is unchanged and still the point: `webmcp` crosses because it is named, and a
 * surface's other fields still do not cross just because the surface is now consulted.
 */
describe('the WebMCP opt-in resolves against the session surface', () => {
  const surface = (mode: 'public' | 'authenticated' | 'mixed', extra: Record<string, unknown>) => ({
    mode,
    origins: [`https://${mode}.acme.test`],
    capabilities: [{ kind: 'tool', name: 'ask' }],
    ...extra,
  });

  it('inherits the deployment default on a surface that says nothing', () => {
    const configuration = assistantBrowserConfiguration(
      { assistant: { webmcp: { enabled: true }, surfaces: [surface('public', {})] } } as never,
      'public',
    );

    expect(configuration?.assistant).toMatchObject({ webmcp: { enabled: true } });
  });

  it('lets a surface enable it where the deployment did not', () => {
    const configuration = assistantBrowserConfiguration(
      {
        assistant: {
          surfaces: [
            surface('public', { webmcp: { enabled: true } }),
            surface('authenticated', {}),
          ],
        },
      } as never,
      'public',
    );

    expect(configuration?.assistant).toMatchObject({ webmcp: { enabled: true } });
  });

  it('lets a surface opt out of a deployment that opted in', () => {
    const server = {
      assistant: {
        webmcp: { enabled: true },
        surfaces: [surface('public', {}), surface('authenticated', { webmcp: { enabled: false } })],
      },
    } as never;

    // The marketing surface keeps the deployment's opt-in; the signed-in one refuses it. One
    // deployment, two answers — which is the whole reason a surface gets to say.
    expect(assistantBrowserConfiguration(server, 'public')?.assistant).toMatchObject({
      webmcp: { enabled: true },
    });
    expect(assistantBrowserConfiguration(server, 'authenticated')?.assistant).toMatchObject({
      webmcp: { enabled: false },
    });
  });

  it('reads a mixed surface as the public binding, in both directions', () => {
    // A `mixed` surface (`signIn: true`) is the anonymous front door that can also elevate; the
    // session it mints is bound `public`, exactly like a plain public surface's. Matching only the
    // literal `public` mode left every mixed surface's `webmcp` unread, so a marketing page that
    // opted in shipped an embed that never registered — the switch existed in the manifest and
    // nowhere else. Both of the first two real opt-ins were mixed surfaces.
    const optedIn = {
      assistant: { surfaces: [surface('mixed', { webmcp: { enabled: true } })] },
    } as never;
    expect(assistantBrowserConfiguration(optedIn, 'public')?.assistant).toMatchObject({
      webmcp: { enabled: true },
    });

    const optedOut = {
      assistant: {
        webmcp: { enabled: true },
        surfaces: [surface('mixed', { webmcp: { enabled: false } })],
      },
    } as never;
    expect(assistantBrowserConfiguration(optedOut, 'public')?.assistant).toMatchObject({
      webmcp: { enabled: false },
    });
  });

  it('falls back to the deployment value when no surface is bound', () => {
    // A pre-surfaces deployment, and any caller that cannot name a surface, reads the assistant's
    // own value rather than an arbitrary surface's.
    const configuration = assistantBrowserConfiguration({
      assistant: {
        webmcp: { enabled: true },
        surfaces: [surface('public', { webmcp: { enabled: false } })],
      },
    } as never);

    expect(configuration?.assistant).toMatchObject({ webmcp: { enabled: true } });
  });

  it('still refuses to carry a surface field the allowlist does not name', () => {
    const configuration = assistantBrowserConfiguration(
      {
        assistant: {
          surfaces: [
            surface('public', {
              webmcp: { enabled: true },
              capabilities: [{ kind: 'tool', name: 'secret' }],
            }),
          ],
        },
      } as never,
      'public',
    );

    expect(JSON.stringify(configuration)).not.toContain('secret');
  });
});
