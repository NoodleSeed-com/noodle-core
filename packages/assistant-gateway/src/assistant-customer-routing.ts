import type { CustomerEndpointPolicy, RuntimeArtifact } from '@noodle-borg/compiler';
import { type ExecuteDeps, freezeCustomerRoutes } from '@noodle-borg/runtime';
import { assistantCustomerIssuer } from './assistant-customer-issuer.js';
import type { AssistantSessionRecord } from './assistant-store.js';

export type AssistantCustomerRouting = Readonly<Record<string, string>>;

export type AssistantCustomerRoutingResult =
  | { readonly ok: true; readonly customerRouting?: AssistantCustomerRouting }
  | { readonly ok: false; readonly endpoint?: string };

/** Validate and canonicalize private customer endpoint authority supplied by an embed backend. */
export function parseAssistantCustomerRouting(
  declarations: Readonly<Record<string, CustomerEndpointPolicy>> | undefined,
  input: unknown,
): AssistantCustomerRoutingResult {
  if (input === undefined) return { ok: true };
  if (!isRecord(input) || !isRecord(input.endpoints)) return { ok: false };

  try {
    const entries = Object.entries(input.endpoints);
    for (const [key, value] of entries) {
      if (!Object.hasOwn(declarations ?? {}, key)) return { ok: false };
      if (typeof value !== 'string') return { ok: false, endpoint: key };
    }

    const raw = Object.fromEntries(entries) as Readonly<Record<string, string>>;
    const frozen = freezeCustomerRoutes(declarations, raw);
    const customerRouting = Object.create(null) as Record<string, string>;
    for (const [key] of entries) {
      const route = frozen.endpoints[key];
      if (route?.available !== true) return { ok: false, endpoint: key };
      customerRouting[key] = route.baseUrl;
    }
    return { ok: true, customerRouting: Object.freeze(customerRouting) };
  } catch {
    return { ok: false };
  }
}

/** Reconstruct all private assistant execution authority from one authenticated session snapshot. */
export function withAssistantSessionExecutionAuthority<T extends ExecuteDeps>(
  deps: T,
  artifact: Pick<RuntimeArtifact, 'customerEndpoints'>,
  session: Pick<AssistantSessionRecord, 'clientId' | 'customerRouting'>,
): T & {
  readonly customerIssuer: string;
  readonly customerRoutes?: ReturnType<typeof freezeCustomerRoutes>;
} {
  return {
    ...deps,
    customerIssuer: assistantCustomerIssuer(session.clientId),
    ...(artifact.customerEndpoints === undefined
      ? {}
      : {
          customerRoutes: freezeCustomerRoutes(artifact.customerEndpoints, session.customerRouting),
        }),
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
