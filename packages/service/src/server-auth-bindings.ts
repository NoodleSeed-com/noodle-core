import type { SecretBinding } from '@noodle-borg/connector-defs';

export function serverAuthSecretBindings(
  auth:
    | {
        readonly kind?: string | undefined;
        readonly provider?: string | undefined;
        readonly clientSecret?: string | undefined;
      }
    | undefined,
): readonly SecretBinding[] {
  if (auth?.kind !== 'bridge' || auth.provider !== 'microsoft' || auth.clientSecret === undefined) {
    return [];
  }
  return [
    {
      connectorId: 'server.auth',
      connectorVersion: '0',
      secretRef: auth.clientSecret,
      authKind: 'delegatedOAuth',
    },
  ];
}
