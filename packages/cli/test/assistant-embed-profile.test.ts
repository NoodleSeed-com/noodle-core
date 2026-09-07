import { describe, expect, it } from 'vitest';
import { embedScaffoldFiles } from '../src/assistant-embed-scaffold-template.js';

describe('application-side assistant profiles', () => {
  it('installs a public mount without inventing a backend exchange or credential', () => {
    const files = embedScaffoldFiles('nextjs', 'public');
    expect(Object.keys(files).some((path) => path.startsWith('app/api/'))).toBe(false);
    expect(Object.keys(files).some((path) => path.startsWith('lib/'))).toBe(false);
    expect(files['components/noodle-assistant.tsx']).toContain('embedId');
    expect(files['components/noodle-assistant.tsx']).not.toContain('sessionEndpoint');
    expect(Object.values(files).join('\n')).not.toContain('NOODLE_ASSISTANT_CLIENT_SECRET');
    expect(files['.env.local.example']).toContain('NEXT_PUBLIC_NOODLE_EMBED_ID=');
    expect(files['.env.local.example']).toContain('PUBLIC_APP_ORIGIN=');
    expect(files['NOODLE-INTEGRATION.md']).toContain(
      '--env-alias NOODLE_SERVICE_URL=NEXT_PUBLIC_NOODLE_SERVICE_URL',
    );
    expect(files['NOODLE-INTEGRATION.md']).toContain('--require-env NEXT_PUBLIC_NOODLE_EMBED_ID');
  });

  it('keeps the authenticated session adapter and explicitly names its only identity seam', () => {
    const files = embedScaffoldFiles('nextjs', 'authenticated');
    expect(files['app/api/assistant/session/route.ts']).toContain('authenticateAssistantRequest');
    expect(files['lib/noodle-assistant-auth.ts']).toContain('return null');
    expect(files['components/noodle-assistant.tsx']).toContain('sessionEndpoint=');
    expect(files['components/noodle-assistant.tsx']).not.toContain('embedId');
  });

  it('gives mixed surfaces a public mount and an explicit application-owned sign-in handoff', () => {
    const files = embedScaffoldFiles('nextjs', 'mixed');
    expect(files['components/noodle-assistant.tsx']).toContain('embedId');
    expect(files['components/noodle-assistant.tsx']).toContain('onSignInRequested');
    expect(files['components/noodle-assistant.tsx']).toContain('principalKey');
    expect(files['components/noodle-assistant.tsx']).toContain(
      'sessionEndpoint="/api/assistant/session"',
    );
    expect(files['components/noodle-assistant.tsx']).toContain('key={principalKey}');
    expect(files['app/api/assistant/session/route.ts']).toContain('authenticateAssistantRequest');
    expect(files['lib/noodle-assistant-auth.ts']).toContain('return null');
    expect(files['NOODLE-INTEGRATION.md']).toContain('unverified');
    expect(files['NOODLE-INTEGRATION.md']).toContain('signInTicket');
    expect(files['NOODLE-INTEGRATION.md']).toContain('existing login');
  });

  it('supplies an application handoff instead of claiming scaffold creation proves integration', () => {
    const files = embedScaffoldFiles('nextjs', 'authenticated');
    const guide = files['NOODLE-INTEGRATION.md'];
    expect(guide).toContain('authenticateAssistantRequest');
    expect(guide).toContain('signed-out');
    expect(guide).toContain('tenant');
    expect(guide).toContain('unverified');
    expect(guide).not.toContain('requireCurrentUser');
  });
});
