import { z } from 'zod';
import type { ConnectionProvider } from './connections/oauth.js';
import { validateProvider } from './connections/oauth.js';
import type { ServeServiceOptions } from './serve-options.js';

const text = z.string().min(1).max(2048);
const ProviderSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  label: z.string().min(1).max(160),
  clientId: text,
  clientSecret: z.string().min(1).max(16384),
  server: z.strictObject({
    issuer: text,
    authorization_endpoint: text,
    token_endpoint: text,
    jwks_uri: text,
    revocation_endpoint: text.optional(),
    authorization_response_iss_parameter_supported: z.boolean().optional(),
    code_challenge_methods_supported: z.array(text).max(16).optional(),
    id_token_signing_alg_values_supported: z.array(text).max(16).optional(),
  }),
  redirectUri: text,
  scopes: z.array(text).min(1).max(100),
  allowedOrigins: z.array(text).min(1).max(16),
  authorizationParameters: z
    .strictObject({
      access_type: text.optional(),
      prompt: text.optional(),
      include_granted_scopes: text.optional(),
    })
    .optional(),
});

/** Operator-owned provider registration; the same input works in hosted and private deployments. */
export function resolveApplicationConnectionsConfig(
  env: NodeJS.ProcessEnv,
): ServeServiceOptions['applicationConnections'] {
  const serialized = env.NOODLE_CONNECTION_PROVIDERS;
  const credentialEpoch = env.NOODLE_CONNECTION_CREDENTIAL_EPOCH;
  if (serialized === undefined && (credentialEpoch === undefined || credentialEpoch === ''))
    return undefined;
  try {
    if (
      !serialized ||
      serialized.length > 131072 ||
      !credentialEpoch ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(credentialEpoch) ||
      !env.NOODLE_PORTAL_URL
    )
      throw new Error();
    const portal = new URL(env.NOODLE_PORTAL_URL);
    if (
      portal.origin !== env.NOODLE_PORTAL_URL ||
      (portal.protocol !== 'https:' &&
        !(
          portal.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(portal.hostname)
        ))
    )
      throw new Error();
    const parsed = z
      .record(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), ProviderSchema)
      .parse(JSON.parse(serialized));
    if (Object.keys(parsed).length < 1 || Object.keys(parsed).length > 32) throw new Error();
    const providers = new Map<string, ConnectionProvider>();
    for (const [id, candidate] of Object.entries(parsed)) {
      // JSON has no undefined properties; validation does not relax the portable provider contract.
      const provider = candidate as ConnectionProvider;
      validateProvider(provider);
      if (provider.redirectUri !== new URL('/api/connections/callback', portal).href)
        throw new Error();
      for (const origin of provider.allowedOrigins)
        if (new URL(origin).origin !== origin) throw new Error();
      providers.set(id, provider);
    }
    return {
      credentialEpoch,
      portalOrigins: [portal.origin],
      providers: async (key) => providers.get(key.connectionId),
    };
  } catch {
    // Do not expose parser issues: this environment value contains operator credentials.
    throw new Error('Application connection host configuration is invalid');
  }
}
