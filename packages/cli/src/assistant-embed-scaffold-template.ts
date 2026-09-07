/**
 * File map for `noodle assistant embed --framework nextjs`: the embedding-app side of the
 * customer-branded assistant (backend session route, client-only mount, env example). The first
 * frontend-emitting scaffold — it writes into an EXISTING web application, so the command
 * reconciles per file and never overwrites user edits without `--force`
 * (docs/roadmap/embedded-assistant-hardening.md S8).
 */

import { djangoEmbedFiles } from './assistant-embed-django.js';
import { embedIntegrationGuide, publicEmbedFiles } from './assistant-embed-profile.js';
import { embedBrowserContractTest, nextSessionContractTest } from './assistant-embed-tests.js';

export type EmbedFramework = 'nextjs' | 'django-vue';
export type EmbedSurface = 'authenticated' | 'public' | 'mixed';

/** Return the canonical files for embedding an assistant in one supported host framework. */
export function embedScaffoldFiles(
  framework: EmbedFramework,
  surface: EmbedSurface = 'authenticated',
): Record<string, string> {
  if (framework === 'django-vue') {
    if (surface !== 'authenticated')
      throw new Error('django-vue supports authenticated surfaces only');
    return djangoEmbedFiles();
  }
  if (framework !== 'nextjs') throw new Error(`unsupported framework: ${String(framework)}`);
  if (surface === 'public') return publicEmbedFiles(surface);
  const files = {
    'app/api/assistant/session/route.ts': `import { createAssistantSessionHandler } from '@noodleseed/assistant/server';
import { authenticateAssistantRequest } from '../../../../lib/noodle-assistant-auth';

// Library-owned guards, bounded parsing and exchange. Only the existing login adapter is app-specific.
// Keep these credentials server-only and preserve any stricter application CSRF middleware.
export const POST = createAssistantSessionHandler({
  serviceUrl: process.env.NOODLE_SERVICE_URL,
  clientId: process.env.NOODLE_ASSISTANT_CLIENT_ID,
  clientSecret: process.env.NOODLE_ASSISTANT_CLIENT_SECRET,
  origin: process.env.PUBLIC_APP_ORIGIN,
  authenticate: authenticateAssistantRequest,
});
`,
    'lib/noodle-assistant-auth.ts': `import type { AssistantSessionIdentity } from '@noodleseed/assistant/server';

/**
 * The only application-specific adapter in the generated integration. Replace the function body with
 * the host application's existing cookie/JWT auth and server-owned membership lookup.
 */
export type NoodleAssistantIdentity = AssistantSessionIdentity;

export async function authenticateAssistantRequest(
  _request: Request,
): Promise<NoodleAssistantIdentity | null> {
  // Return null for a signed-out request; the route converts it to a JSON 401. Do not redirect here.
  // Derive roles, scopes, claims, and routing only from verified backend state. In particular,
  // routing.endpoints must come from server-owned membership, never request JSON or headers.
  // For mixed-mode continuation, return signInTicket only from the backend-bound login transaction;
  // browser JSON cannot select it. The library preserves the continued session and automatic resume.
  //
  // The route's JSON content type plus exact-Origin check is its minimum cookie/CSRF boundary. If the
  // host requires a CSRF token header, keep that middleware and use the DOM-free client with an injected
  // fetch that supplies the token; do not exempt this route or return an HTML redirect.
  return null;
}
`,
    'test/noodle-assistant.test.ts': nextSessionContractTest(),
    'test/noodle-assistant.browser.mjs': embedBrowserContractTest(),
    'components/noodle-assistant.tsx': `'use client';

import dynamic from 'next/dynamic';

// The assistant renders a custom element and must mount client-side only (no SSR).
const NoodleAssistant = dynamic(
  () => import('@noodleseed/assistant/react').then((mod) => mod.NoodleAssistant),
  { ssr: false },
);

/** Mount only inside the authenticated application surface. */
export function AssistantWidget({ principalKey }: { readonly principalKey: string }) {
  // Stable user/tenant key from existing application state. Remount when the account changes.
  // This key clears browser state; the backend session adapter remains the identity authority.
  return <NoodleAssistant key={principalKey} sessionEndpoint="/api/assistant/session" theme="auto" />;
}
`,
    '.env.local.example': `# Backend-only assistant credentials — from \`noodle assistant clients create\`.
# Never expose these through a browser-prefixed variable (NEXT_PUBLIC_*).
# NOODLE_SERVICE_URL is the Noodle Seed control plane, not your MCP deployment URL.
NOODLE_SERVICE_URL=https://cloud.noodleseed.dev
NOODLE_ASSISTANT_CLIENT_ID=
NOODLE_ASSISTANT_CLIENT_SECRET=
# The exact origin this app is served from; must appear in the server's allowedOrigins.
PUBLIC_APP_ORIGIN=http://localhost:3000
# If you set a Content-Security-Policy, allow both connect-src and frame-src to the
# NOODLE_SERVICE_URL origin. Verify host readiness with:
# noodle assistant embed --check --json
`,
  };
  return {
    ...files,
    ...(surface === 'mixed' ? publicEmbedFiles(surface) : {}),
    '.env.local.example':
      files['.env.local.example'] +
      (surface === 'mixed' ? publicEmbedFiles(surface)['.env.local.example'] : ''),
    'NOODLE-INTEGRATION.md': embedIntegrationGuide(surface),
  };
}
