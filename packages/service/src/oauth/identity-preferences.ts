import { parseAssistantContextPreferences } from '@noodle-borg/assistant-gateway/portable';
import type { VerifiedIdentity } from '@noodle-borg/auth';

export interface OAuthIdentityPreferences {
  readonly locale?: string;
  readonly timeZone?: string;
}

/** Canonicalize optional verified-identity preferences independently; invalid members are omitted. */
export function canonicalOAuthIdentityPreferences(input: {
  readonly locale?: unknown;
  readonly timeZone?: unknown;
}): OAuthIdentityPreferences {
  const locale = canonicalPreference('locale', input.locale);
  const timeZone = canonicalPreference('timeZone', input.timeZone);
  return {
    ...(locale !== undefined ? { locale } : {}),
    ...(timeZone !== undefined ? { timeZone } : {}),
  };
}

/** Consent claims are server-signed but still fail closed if an optional preference is not canonical. */
export function hasCanonicalOAuthIdentityPreferences(input: {
  readonly locale?: unknown;
  readonly timeZone?: unknown;
}): boolean {
  const canonical = canonicalOAuthIdentityPreferences(input);
  return (
    (input.locale === undefined || canonical.locale === input.locale) &&
    (input.timeZone === undefined || canonical.timeZone === input.timeZone)
  );
}

export function storedOAuthOwnerPreferences(input: {
  readonly locale?: unknown;
  readonly timeZone?: unknown;
}): { readonly ownerLocale?: string; readonly ownerTimeZone?: string } {
  const preferences = canonicalOAuthIdentityPreferences(input);
  return {
    ...(preferences.locale !== undefined ? { ownerLocale: preferences.locale } : {}),
    ...(preferences.timeZone !== undefined ? { ownerTimeZone: preferences.timeZone } : {}),
  };
}

export function verifiedIdentityOwnerPreferences(identity: VerifiedIdentity): {
  readonly ownerLocale?: string;
  readonly ownerTimeZone?: string;
} {
  const value = identity as unknown as Readonly<Record<string, unknown>>;
  return storedOAuthOwnerPreferences({ locale: value.locale, timeZone: value.timeZone });
}

function canonicalPreference(
  field: keyof OAuthIdentityPreferences,
  value: unknown,
): string | undefined {
  if (value === undefined) return undefined;
  const parsed = parseAssistantContextPreferences({ [field]: value });
  return parsed.ok ? parsed.value[field] : undefined;
}
