import type { ArtifactServer } from '@noodle-borg/compiler';
import {
  type AssistantAppearanceOverride,
  resolveAssistantAppearanceConfiguration,
} from './assistant-appearance.js';
import type { AssistantAppearanceSettingsStore } from './assistant-appearance-store.js';
import { ASSISTANT_BROWSER_UI_FIELDS } from './assistant-browser-fields.js';
import type { TenantRef } from './tenant-ref.js';

type BusinessNoticeDisplay = {
  readonly displayName: string;
  readonly privacyUrl: string;
  readonly supportUrl: string;
};
const noticeText = (notice: BusinessNoticeDisplay) =>
  `Information is shared with ${notice.displayName}. Support: ${notice.supportUrl}`;

/** A current action must not silently use a different recipient from the session's visible notice. */
export function assistantConfigurationHasBusinessNotice(
  configuration: AssistantAppearanceOverride | undefined,
  notice: BusinessNoticeDisplay,
): boolean {
  const text = noticeText(notice);
  const welcome = configuration?.assistant?.labels?.welcomeMessage;
  return (
    configuration?.branding?.name === notice.displayName &&
    configuration?.assistant?.privacyUrl === notice.privacyUrl &&
    (welcome === text || welcome?.startsWith(`${text}\n\n`) === true)
  );
}

/**
 * What the browser is allowed to see.
 *
 * The session response's `configuration` crosses to the browser, and its wire schema is
 * `z.record(z.unknown())` — it validates nothing. This was previously "everything on `server.assistant`
 * except `model` and `allowedOrigins`", which is a denylist: it already shipped `sessionClaims` key
 * names to every embed, and it would ship a public page the server's internal capability allowlist.
 *
 * An explicit allowlist inverts the default. A field reaches a customer's page because it is named
 * in `ASSISTANT_BROWSER_UI_FIELDS`, not because nobody remembered to exclude it — so growth in the
 * manifest cannot silently grow the browser payload. That list is owned by the gateway, beside the
 * record type it produces, so this projection and the type it satisfies cannot disagree.
 */
export function assistantBrowserConfiguration(
  server: ArtifactServer,
  boundSurface?: 'public' | 'authenticated',
): AssistantAppearanceOverride | undefined {
  const assistant = server.assistant as Record<string, unknown> | undefined;
  const ui: Record<string, unknown> = {};
  for (const field of ASSISTANT_BROWSER_UI_FIELDS) {
    const value = assistant?.[field];
    if (value !== undefined) ui[field] = value;
  }
  // `webmcp` is the one field the session's own surface may answer differently (ADR 0220, amended):
  // it decides whether this embed registers its tools with `document.modelContext`, and a deployment
  // serving a marketing page and a signed-in app has two honest answers to that. Read from the bound
  // surface only — a caller that cannot name one, including a pre-surfaces deployment, gets the
  // assistant's own value rather than an arbitrary surface's. Nothing else is read here, so
  // consulting the surface cannot widen what crosses to the browser.
  const surfaceWebmcp = surfaceOfMode(assistant, boundSurface)?.webmcp;
  if (surfaceWebmcp !== undefined) ui.webmcp = surfaceWebmcp;
  const configuration = {
    ...(server.branding ? { branding: server.branding } : {}),
    ...(Object.keys(ui).length > 0 ? { assistant: ui } : {}),
  };
  return Object.keys(configuration).length > 0
    ? (configuration as AssistantAppearanceOverride)
    : undefined;
}

function surfaceOfMode(
  assistant: Record<string, unknown> | undefined,
  mode: 'public' | 'authenticated' | undefined,
): { readonly webmcp?: unknown } | undefined {
  if (mode === undefined || !Array.isArray(assistant?.surfaces)) return undefined;
  // A `mixed` surface mints `public` sessions (ADR 0220): it is the public binding's surface.
  return (assistant.surfaces as { readonly mode?: unknown; readonly webmcp?: unknown }[]).find(
    (surface) => surface.mode === mode || (mode === 'public' && surface.mode === 'mixed'),
  );
}

/** Resolve environment operator state above the immutable deployment projection. */
export async function effectiveAssistantBrowserConfiguration(
  server: ArtifactServer,
  tenant: TenantRef,
  store: AssistantAppearanceSettingsStore | undefined,
  boundSurface?: 'public' | 'authenticated',
  notice?: BusinessNoticeDisplay,
) {
  const developer = assistantBrowserConfiguration(server, boundSurface);
  const record = await store?.get(tenant);
  const resolved = resolveAssistantAppearanceConfiguration(developer, record?.override);
  // Receiving-business authority is separate from optional appearance; use fields old widgets render.
  const requiredNotice = notice && noticeText(notice);
  const originalWelcome = resolved.effective?.assistant?.labels?.welcomeMessage;
  const welcome =
    requiredNotice &&
    requiredNotice +
      (originalWelcome
        ? `\n\n${originalWelcome}`.slice(0, Math.max(0, 1000 - requiredNotice.length))
        : '');
  return {
    developer,
    record,
    ...resolved,
    ...(notice
      ? {
          effective: {
            ...resolved.effective,
            branding: { ...resolved.effective?.branding, name: notice.displayName },
            assistant: {
              ...resolved.effective?.assistant,
              privacyUrl: notice.privacyUrl,
              labels: { ...resolved.effective?.assistant?.labels, welcomeMessage: welcome ?? '' },
            },
          },
        }
      : {}),
  };
}
