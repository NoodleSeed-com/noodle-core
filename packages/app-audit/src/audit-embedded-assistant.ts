import type { RuntimeArtifact } from '@noodle-borg/compiler';
import { isSafeReadTool, requiresToolConfirmation } from '@noodle-borg/compiler';
import { type AuditFinding, toolNames } from './mcp-apps-audit.js';
import { isModelVisibleTool } from './tool-design-audit.js';

/**
 * What `noodle check --target embedded-assistant` reports.
 *
 * Reporting only — every rule here that could be enforced already is, at compile time. `check` runs a
 * full compile first and returns early on failure, so an artifact violating a public-surface invariant
 * never reaches this function. What belongs here is what the compiler cannot decide: configuration a
 * developer should look at before pointing the public internet at it.
 */

/**
 * The public/mixed surface this artifact declares, read locally rather than through the gateway's
 * `publicSurfaceOf`. That reader is the enforcement path and lives beside a Postgres dependency; the CLI
 * publishes to npm and must not drag `pg` into a customer's install for a reporting line.
 */
interface PublicSurfaceSummary {
  readonly mode: string;
  readonly origins: readonly string[];
  readonly capabilities: readonly string[];
}

function publicSurfaceSummary(assistant: unknown): PublicSurfaceSummary | undefined {
  const surfaces = (assistant as { surfaces?: unknown } | undefined)?.surfaces;
  if (!Array.isArray(surfaces)) return undefined;
  for (const entry of surfaces) {
    const { mode, origins, capabilities } = entry as {
      mode?: unknown;
      origins?: unknown;
      capabilities?: unknown;
    };
    if (mode !== 'public' && mode !== 'mixed') continue;
    return {
      mode,
      origins: Array.isArray(origins) ? (origins as readonly string[]) : [],
      capabilities: Array.isArray(capabilities)
        ? (capabilities as readonly { name: string }[]).map((entry) => entry.name)
        : [],
    };
  }
  return undefined;
}

/**
 * What a public page must allow for the assistant to load at all.
 *
 * This exists here rather than in the widget because the worst CSP failure is undetectable from inside:
 * if `script-src` blocks the embed script, no widget code runs to complain. Before deploy is the only
 * place that half can be named.
 */
function publicSurfaceFindings(
  surface: PublicSurfaceSummary,
  privacyUrl: string | undefined,
): readonly AuditFinding[] {
  return [
    {
      code: 'assistant_public_surface',
      severity: 'info',
      message: `A ${surface.mode} website surface serves ${surface.origins.join(', ') || 'no origins'} and exposes: ${surface.capabilities.join(', ') || 'nothing'}.`,
      cause:
        'Anyone who loads one of those origins reaches these capabilities with no account and no sign-in.',
      fix: 'Keep the capability list to what a stranger should be able to do; everything else belongs on an authenticated surface.',
      next: 'noodle check --target embedded-assistant',
    },
    {
      code: 'assistant_public_disclosure',
      severity: privacyUrl === undefined ? 'warn' : 'info',
      message:
        privacyUrl === undefined
          ? 'This public surface has no privacy link, so visitors are told nothing about what they type.'
          : 'The public surface discloses a privacy link.',
      cause: 'A public assistant collects whatever a stranger types into it, without an account.',
      fix: 'Set privacyUrl on embeddedAssistant(...) so the widget can link your privacy policy.',
      next: 'noodle check --target embedded-assistant',
    },
    {
      code: 'assistant_public_csp',
      severity: 'info',
      message:
        'The embedding page must allow the service origin in script-src (the embed script), connect-src (session and turns), and frame-src (widget sandbox).',
      cause:
        'A page whose script-src blocks the embed cannot report it: no widget code runs, so the assistant is simply absent.',
      fix: 'Add your Noodle service origin to those three directives in the page Content-Security-Policy.',
      next: 'noodle deploy',
    },
    {
      code: 'assistant_public_budget',
      severity: 'info',
      message:
        'Daily turn and session caps bound what this surface may spend; setting either to zero switches it off.',
      cause:
        'A public surface faces the open internet, so its spend is capped per surface rather than per service.',
      fix: 'Read the live caps and today’s consumption, then raise, lower, or switch the surface off.',
      // Deliberately not restating the default numbers: an operator override makes any number printed
      // here wrong, and packages/admission-limits (which owns them) carries a pg dependency the
      // published CLI must not acquire.
      next: 'noodle assistant embeds list',
    },
  ];
}

export function auditEmbeddedAssistant(artifact: RuntimeArtifact): readonly AuditFinding[] {
  const assistant = artifact.server.assistant;
  if (!assistant) {
    return [
      {
        code: 'assistant_configuration',
        severity: 'error',
        message: 'No embedded assistant is declared.',
        cause: 'The embedded-assistant host needs model and exact-origin configuration.',
        fix: 'Add assistant: embeddedAssistant(...) to server options.',
        next: 'noodle check --target embedded-assistant',
      },
    ];
  }
  const confirmGated = artifact.tools.filter(
    (tool) => isModelVisibleTool(tool) && requiresToolConfirmation(tool.annotations),
  );
  const unconfirmedEffects = artifact.tools.filter(
    (tool) =>
      isModelVisibleTool(tool) &&
      !isSafeReadTool(tool.annotations) &&
      !requiresToolConfirmation(tool.annotations),
  );
  const branding = artifact.server.branding;
  const theme = branding?.theme;
  const surface = publicSurfaceSummary(assistant);
  return [
    ...(surface
      ? publicSurfaceFindings(surface, (assistant as { privacyUrl?: string }).privacyUrl)
      : []),
    {
      code: 'assistant_configuration',
      severity: 'info',
      message: `Embedded assistant uses ${assistant.model.kind} with ${assistant.allowedOrigins.length} allowed origin(s).`,
      cause: 'Model credentials remain managed config and origins bind browser sessions.',
      fix: 'Keep model variables, the API-key secret, and every production SaaS origin configured.',
      next: 'noodle variables list && noodle secrets list',
    },
    {
      code: 'assistant_session_claims',
      severity: 'info',
      message: assistant.sessionClaims
        ? `Declared session claims: ${Object.entries(assistant.sessionClaims)
            .map(([key, spec]) => `${key}${spec?.exposeToModel ? ' (model)' : ' (tools only)'}`)
            .join(', ')}.`
        : 'No sessionClaims declared; backend-passed claims are dropped at session exchange.',
      cause:
        'Verified session context flows only through the embeddedAssistant sessionClaims allowlist.',
      fix: 'Declare each claim your backend passes; mark exposeToModel for values the assistant should see.',
      next: 'noodle check --target embedded-assistant',
    },
    {
      code: 'assistant_customer_auth',
      severity: artifact.server.auth === undefined ? 'warn' : 'info',
      message:
        artifact.server.auth === undefined
          ? 'No server.auth is declared; a customers-access deploy will be rejected.'
          : 'server.auth is declared, so customers access mode can be deployed.',
      cause: 'The customers access mode requires server.auth to verify the embedding SaaS user.',
      fix:
        artifact.server.auth === undefined
          ? 'Add auth to server.ts with customerAuth.federatedOidc(...), customerAuth.oidc(...), or a managed adapter like customerAuth.firebase(...).'
          : 'Keep the auth configuration in sync with your identity provider.',
      next: 'noodle deploy --access customers',
    },
    {
      code: 'assistant_embedding_workflow',
      severity: 'info',
      message: 'The assistant metadata is ready for the deployment-bound embedding workflow.',
      cause:
        'External browser sessions require an active assistant deployment before a backend client can be created.',
      fix: 'Deploy first, create the assistant client second, then exchange the authenticated SaaS user through @noodleseed/assistant/server and mount the browser SDK.',
      next: 'noodle deploy',
    },
    {
      code: 'assistant_themes',
      severity: theme?.light && theme.dark ? 'info' : 'warn',
      message:
        theme?.light && theme.dark
          ? `Server branding declares light and dark overrides with ${branding?.colorScheme ?? 'auto'} mode.`
          : 'One or both customer theme overrides are omitted; accessible built-in defaults will be used.',
      cause: 'One server brand kit keeps widgets and the embedded assistant visually consistent.',
      fix: 'Optionally declare branding.theme.light and branding.theme.dark semantic overrides.',
      next: 'noodle dev',
    },
    {
      code: 'assistant_consent_metadata',
      severity: unconfirmedEffects.length === 0 ? 'info' : 'warn',
      message:
        unconfirmedEffects.length > 0
          ? `These model-visible effect tools are not confirmation-gated: ${toolNames(unconfirmedEffects)}.`
          : confirmGated.length > 0
            ? `These tools require an end-user confirmation: ${toolNames(confirmGated)}.`
            : 'Every model-visible tool is a declared safe read and runs without a confirmation prompt.',
      cause:
        unconfirmedEffects.length > 0
          ? 'Manifest confirmation is explicit; non-safe tools without confirm: true execute directly.'
          : 'Confirmation is enabled only by explicit confirm: true; action hints alone do not enable it.',
      fix: 'Reads: annotations.readOnly() (closed-world). Writes: annotations.action(); add { confirm: true } when runtime-enforced approval is required. Omitted or false executes directly.',
      next: 'noodle check --target embedded-assistant',
    },
  ];
}
