import { describe, expect, it } from 'vitest';
import app from '../src/server.js';

describe('Google BigQuery workload-identity flagship', () => {
  it('binds a read-only Google operation to keyless service-account impersonation', async () => {
    const manifest = await app.toManifest();
    expect(manifest.connectors?.bigquery).toMatchObject({
      id: 'google_bigquery',
      binding: {
        profile: 'google_wif',
        connection: {
          id: 'customer_google_cloud',
          source: {
            kind: 'googleWorkloadIdentity',
            provider: '${env.GOOGLE_WIF_PROVIDER}',
            access: {
              kind: 'serviceAccountImpersonation',
              serviceAccount: '${env.GOOGLE_SERVICE_ACCOUNT}',
            },
          },
        },
      },
    });
    expect(app.toConnectorCatalog()).toMatchObject({
      connectors: [
        {
          credentialProfiles: { google_wif: { kind: 'bearer' } },
          operations: {
            query: {
              credentials: {
                profiles: ['google_wif'],
                scopes: ['https://www.googleapis.com/auth/bigquery.readonly'],
                audience: 'https://bigquery.googleapis.com',
              },
            },
          },
        },
      ],
    });
    expect(JSON.stringify({ manifest, catalog: app.toConnectorCatalog() })).not.toMatch(
      /private[_-]?key|client[_-]?secret|access[_-]?token/i,
    );
  });
});
