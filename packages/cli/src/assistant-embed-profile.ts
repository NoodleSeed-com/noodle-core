import type { EmbedSurface } from './assistant-embed-scaffold-template.js';
import { embedBrowserContractTest } from './assistant-embed-tests.js';

/** Reuse preflight's explicit env aliases instead of duplicating browser configuration. */
export function embedCheckCommand(surface: EmbedSurface): string {
  const flags =
    surface === 'public'
      ? ' --env-alias NOODLE_SERVICE_URL=NEXT_PUBLIC_NOODLE_SERVICE_URL --require-env NEXT_PUBLIC_NOODLE_EMBED_ID'
      : surface === 'mixed'
        ? ' --require-env NEXT_PUBLIC_NOODLE_EMBED_ID --require-env NEXT_PUBLIC_NOODLE_SERVICE_URL'
        : '';
  return `noodle assistant embed --check --surface ${surface}${flags} --json`;
}

/** Public mounting uses the existing hosted session source, never a customer proxy route. */
export function publicEmbedFiles(surface: 'public' | 'mixed'): Record<string, string> {
  const mixed = surface === 'mixed';
  return {
    'test/noodle-assistant.browser.mjs': embedBrowserContractTest(),
    'components/noodle-assistant.tsx': `'use client';

import dynamic from 'next/dynamic';
${mixed ? "import { useEffect, useRef } from 'react';\n" : ''}
const NoodleAssistant = dynamic(
  () => import('@noodleseed/assistant/react').then((mod) => mod.NoodleAssistant),
  { ssr: false },
);
${
  mixed
    ? `
export interface AssistantSignInRequest {
  readonly signInTicket: string;
  readonly expiresAt: string;
  readonly intent: 'sign-in' | 'sign-up';
}

/** Bind the ticket to your backend's existing login transaction; never put it in a URL or storage. */
export function AssistantWidget({ principalKey, onSignInRequested }: {
  /** Null while anonymous; change this stable user/tenant key whenever the signed-in account changes. */
  readonly principalKey: string | null;
  readonly onSignInRequested: (request: AssistantSignInRequest) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const signIn = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (typeof detail !== 'object' || detail === null ||
          !('signInTicket' in detail) || typeof detail.signInTicket !== 'string' ||
          !('expiresAt' in detail) || typeof detail.expiresAt !== 'string' ||
          !('intent' in detail) || (detail.intent !== 'sign-in' && detail.intent !== 'sign-up')) return;
      onSignInRequested({ signInTicket: detail.signInTicket, expiresAt: detail.expiresAt, intent: detail.intent });
    };
    element.addEventListener('assistant-sign-in-requested', signIn);
    return () => element.removeEventListener('assistant-sign-in-requested', signIn);
  }, [onSignInRequested]);
  return <div ref={host}>{principalKey === null ? <NoodleAssistant
    key="anonymous"
    embedId={process.env.NEXT_PUBLIC_NOODLE_EMBED_ID}
    serviceUrl={process.env.NEXT_PUBLIC_NOODLE_SERVICE_URL}
    theme="auto"
  /> : <NoodleAssistant
    key={principalKey}
    sessionEndpoint="/api/assistant/session"
    theme="auto"
  />}</div>;
}`
    : `
/** The embed ID is public configuration; the runtime owns anonymous sessions and admission. */
export function AssistantWidget() {
  return <NoodleAssistant
    embedId={process.env.NEXT_PUBLIC_NOODLE_EMBED_ID}
    serviceUrl={process.env.NEXT_PUBLIC_NOODLE_SERVICE_URL}
    theme="auto"
  />;
}`
}
`,
    '.env.local.example': `# Public configuration only; safe in the browser bundle.
# Use the local embed ID printed by noodle dev, or the hosted ID printed by noodle deploy.
NEXT_PUBLIC_NOODLE_EMBED_ID=
NEXT_PUBLIC_NOODLE_SERVICE_URL=https://cloud.noodleseed.dev
${mixed ? '' : 'PUBLIC_APP_ORIGIN=http://localhost:3000\n'}# Run checks with these names exported; the CLI does not load application dotenv files.
# Declare the page's exact origin in publicWebsite({ origins: [...] }).
# If the host sends CSP, allow the service in connect-src and frame-src.
# Script-tag mounts also require script-src. No customer backend config route is needed.
`,
    'NOODLE-INTEGRATION.md': embedIntegrationGuide(surface),
  };
}

/** One customer handoff accompanies every installed profile and its machine-readable plan. */
export function embedIntegrationGuide(surface: EmbedSurface): string {
  return `# Noodle application integration

Surface: **${surface}**. Installation is not integration proof: application authorization, backend operations
and browser behavior are **unverified** until the checks below execute against your application.

## Application-owned changes

${
  surface === 'public'
    ? `Set the public embed ID and service URL, then render \`AssistantWidget\`. Public sessions need no customer
backend session/config route or backend credential. Reuse existing business endpoints for capability data.
Public admission and capability allowlists are enforced by the runtime; Origin alone is not authentication.`
    : `Implement \`authenticateAssistantRequest\` in \`lib/noodle-assistant-auth.ts\` using the existing login/session
and backend membership checks. It returns null for signed-out callers. Derive identity, tenant, roles,
scopes and routing server-side; never accept them from browser JSON. Preserve your application's CSRF policy.
Keep backend exchange credentials in the existing server secret manager, never in browser-prefixed variables.`
}
${
  surface === 'mixed'
    ? `
Supply \`AssistantWidget\`'s \`principalKey\` (null while anonymous, then a stable user/tenant key) and
\`onSignInRequested\` callback. The key resets browser state on account changes; it is not authentication.
Bind \`signInTicket\` to a short-lived backend login
transaction before using the existing login or signup flow. After authentication, spend that ticket through
the generated authentication adapter by returning \`signInTicket\` with the verified user; the maintained handler
spends it and forwards the response unchanged
through the destination's same-origin session endpoint. Never put a ticket in URLs, analytics, logs or durable
browser storage. Ticket possession is not authentication or confirmation. This application-owned transaction
is unverified until your login round trip is tested; do not silently replace it with a new anonymous session.
`
    : ''
}

Reuse the application's existing business functions and authorization. Add a thin stable HTTPS handler only
when no suitable API exists. Keep \`server.ts\` in the Noodle project; do not duplicate business logic or create
a second login system. The customer application remains the system of record.

## Verify before declaring readiness

1. Install a compatible \`@noodleseed/assistant\` version in this application's package manager and build the host.
${surface === 'public' ? '' : '   The server entry must export `createAssistantSessionHandler`. Run the supplied contract suite with your Vitest runner: `vitest run test/noodle-assistant.test.ts`. If the application has no Vitest dependency, add it using its existing package manager first. The suite exercises the generated route with synthetic identities; add real session/membership acceptance cases in your existing test harness.\n'}
2. Configure the exact origins and operator bindings; do not put environment-specific secrets in source.
3. With these environment names exported, run \`${embedCheckCommand(surface)}\`; this is static evidence only.
4. ${surface === 'public' ? 'Exercise anonymous discovery and a safe handoff, and prove private capabilities are unavailable.' : 'Test signed-out JSON 401, wrong-origin rejection, invalid JSON/content type, and successful verified identity.'}
5. Test cross-tenant denial at the real application boundary and an authorized read plus confirmed action or handoff.
6. Exercise the actual browser mount, CSP, one turn and any linked App in an authorized local or sandbox environment.

The supplied mount check runs with \`node --test test/noodle-assistant.browser.mjs\` while the application is
running at \`PUBLIC_APP_ORIGIN\`. It uses Playwright and Chromium; reuse the application's browser-test setup,
or add Playwright as a development dependency and install Chromium first. Reuse existing login fixtures for
protected pages. This check does not submit a turn, confirm an action or claim production readiness.

Missing credentials, a test identity, a reachable sandbox or an authorized action remain unverified. Mock tests
prove only their fixtures. Do not call a production mutation just to complete a check.

## Ownership and updates

These files are customer-owned after installation. Preview with \`noodle assistant embed --surface ${surface} --dry-run --json\`;
reruns create missing files and report conflicts without overwriting modifications. Review changes before using
\`--force\`. Keep custom session/business code and secrets; update library versions through the normal dependency
workflow and rerun the integration checks. Deployment, configuration writes and publication need their own authority.

Guide: https://docs.noodleseed.dev/docs/guides/embedded-assistant
`;
}
