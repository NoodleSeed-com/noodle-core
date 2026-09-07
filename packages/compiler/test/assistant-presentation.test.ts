import { describe, expect, it } from 'vitest';
import { compile } from '../src/compile.js';

const base = (presentation: string) => `
manifestVersion: "1"
server:
  name: embedded
  version: 1.0.0
  title: Embedded
  assistant:
    model: { kind: openai-compatible, baseUrl: https://models.example/v1, model: example, apiKey: KEY }
    allowedOrigins: [https://app.example.com]
${presentation}
tools:
  - name: health
    description: Read health.
    inputSchema: { type: object }
    fulfilment: { steps: [], output: { ok: true } }
`;

describe('embedded assistant presentation manifest', () => {
  it('carries the bounded Atlas presentation into the runtime artifact', () => {
    const result = compile(
      base(`    layout:
      edgeOffset: 20
    labels:
      thinking: Atlas is thinking
      launcherPlaceholder: Ask Atlas anything
      sessionReady: Atlas support is online
    theme: invert
    behavior: { showPoweredBy: false, showConfirmationDetails: false }
    presentation:
      panel: { surface: solid, elevation: dramatic, border: strong, radius: 20 }
      launcher: { style: bubble, icon: chat, size: lg, status: session, effect: pulse }
      header:
        mark: status
        badge: { text: ONLINE, tone: success, indicator: true }
      composer: { leadingIcon: brand-mark, sendIcon: paper-plane, shape: rounded }
      messages: { userStyle: accent, assistantStyle: bubble }`),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.server.assistant).toMatchObject({
      layout: { edgeOffset: 20 },
      theme: 'invert',
      behavior: { showPoweredBy: false, showConfirmationDetails: false },
      labels: {
        thinking: 'Atlas is thinking',
        launcherPlaceholder: 'Ask Atlas anything',
        sessionReady: 'Atlas support is online',
      },
      presentation: {
        panel: {
          surface: 'solid',
          elevation: 'dramatic',
          border: 'strong',
          radius: 20,
        },
        launcher: {
          style: 'bubble',
          icon: 'chat',
          size: 'lg',
          status: 'session',
          effect: 'pulse',
        },
        header: {
          mark: 'status',
          badge: { text: 'ONLINE', tone: 'success', indicator: true },
        },
        composer: { leadingIcon: 'brand-mark', sendIcon: 'paper-plane', shape: 'rounded' },
        messages: { userStyle: 'accent', assistantStyle: 'bubble' },
      },
    });
  });

  it.each([
    ['raw CSS', '      panel: { css: "background: red" }'],
    ['retired structured empty state', '      emptyState: { variant: hero }'],
    ['retired launcher variant', '      launcher: { variant: orbital }'],
    ['retired header actions', '      header: { actions: [{ kind: reset }] }'],
    ['retired footer', '      footer: { center: { text: ASTRA } }'],
    ['retired glow elevation', '      panel: { elevation: glow }'],
    ['retired expressive motion', '      panel: { motion: expressive }'],
    ['retired sparkle icon', '      composer: { leadingIcon: sparkles }'],
    ['oversized radius', '      panel: { radius: 65 }'],
  ])('rejects %s instead of treating it as a renderer escape hatch', (_name, body) => {
    const result = compile(base(`    presentation:\n${body}`));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.path.includes('assistant.presentation'))).toBe(true);
  });

  it('rejects empty accessible labels used by the Atlas shell', () => {
    const result = compile(base('    labels: { composerPlaceholder: "", sessionReady: "" }'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.path.includes('assistant.labels'))).toBe(true);
  });

  it('carries the authored sign-in and sign-up labels into the runtime artifact', () => {
    const result = compile(
      base(`    labels:
      signInHeading: Continue with your Atlas account
      signInBody: Order history needs an account.
      signInAction: Sign in to Atlas
      signUpAction: Create free account`),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.server.assistant).toMatchObject({
      labels: {
        signInHeading: 'Continue with your Atlas account',
        signInBody: 'Order history needs an account.',
        signInAction: 'Sign in to Atlas',
        signUpAction: 'Create free account',
      },
    });
  });

  it.each([
    ['an empty sign-in action', '    labels: { signInAction: "" }'],
    ['an over-long sign-up action', `    labels: { signUpAction: "${'x'.repeat(81)}" }`],
    ['an over-long sign-in body', `    labels: { signInBody: "${'x'.repeat(241)}" }`],
  ])('rejects %s on the identity-moment card', (_name, body) => {
    const result = compile(base(body));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.path.includes('assistant.labels'))).toBe(true);
  });
});
