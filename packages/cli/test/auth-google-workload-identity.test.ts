import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeConfig } from '../src/config.js';
import { run } from '../src/index.js';
import { chdirIsolated, restoreCwd } from './helpers/isolated-cwd.js';

let home: string;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-auth-google-'));
  chdirIsolated(home);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  writeConfig(
    {
      serviceUrl: 'https://cloud.noodleseed.dev',
      authToken: 'operator-token',
      defaultOrg: 'acme',
      defaultApp: 'analytics',
      defaultEnv: 'prod',
    },
    home,
  );
});

afterEach(() => {
  restoreCwd();
  logSpy.mockRestore();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

describe('noodle auth google', () => {
  it('prepares the platform identity and prints complete keyless service-account setup', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ok: true,
        data: {
          status: 'active',
          subject: 'noodle:google-workload:identity-1',
          issuer: 'https://cloud.noodleseed.dev',
          oidcDiscoveryUrl: 'https://cloud.noodleseed.dev/.well-known/openid-configuration',
          jwksUrl: 'https://cloud.noodleseed.dev/.well-known/jwks.json',
          attributeMapping: {
            'google.subject': 'assertion.sub',
            'attribute.tenant_id': 'assertion.tenant_id',
          },
          attributeCondition: "assertion.tenant_id == 'acme/analytics/prod'",
          createdAt: '2026-07-23T12:00:00.000Z',
          updatedAt: '2026-07-23T12:00:00.000Z',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(
      await run(
        [
          'auth',
          'google',
          'prepare',
          '--project-number',
          '130949485844',
          '--pool',
          'noodle-prod',
          '--provider',
          'analytics',
          '--service-account',
          'analytics-reader@customer-project.iam.gserviceaccount.com',
        ],
        {},
        home,
      ),
    ).toBe(0);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://cloud.noodleseed.dev/v1/orgs/acme/apps/analytics/envs/prod/auth/google-workload-identity',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.any(Headers),
      }),
    );
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Headers).get('authorization')).toBe(
      'Bearer operator-token',
    );
    const output = lines();
    expect(output).toContain(
      'gcloud services enable iam.googleapis.com cloudresourcemanager.googleapis.com iamcredentials.googleapis.com sts.googleapis.com --project 130949485844',
    );
    expect(output).toContain('gcloud iam workload-identity-pools providers create-oidc analytics');
    expect(output).toContain('--issuer-uri https://cloud.noodleseed.dev');
    expect(output).toContain(
      '--attribute-mapping "google.subject=assertion.sub,attribute.tenant_id=assertion.tenant_id"',
    );
    expect(output).toContain(
      '--attribute-condition "assertion.tenant_id == \'acme/analytics/prod\'"',
    );
    expect(output).toContain(
      'principal://iam.googleapis.com/projects/130949485844/locations/global/workloadIdentityPools/noodle-prod/subject/noodle:google-workload:identity-1',
    );
    expect(output).toContain('roles/iam.workloadIdentityUser');
    expect(output).toContain('--project customer-project');
    expect(output).toContain(
      'noodle variables set GOOGLE_WIF_PROVIDER --value projects/130949485844/locations/global/workloadIdentityPools/noodle-prod/providers/analytics',
    );
    expect(output).toContain(
      'noodle variables set GOOGLE_SERVICE_ACCOUNT --value analytics-reader@customer-project.iam.gserviceaccount.com',
    );
    expect(output).not.toContain('operator-token');
    expect(output).not.toContain('service account key');
  });

  it('rejects unsafe Google resource values before control-plane access', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', fetchMock);

    expect(
      await run(
        [
          'auth',
          'google',
          'prepare',
          '--project-number',
          '130949485844',
          '--pool',
          'noodle-prod;echo-bad',
          '--provider',
          'analytics',
        ],
        {},
        home,
      ),
    ).toBe(2);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      '--pool must be a 4-32 character lowercase Google resource id.',
    );
    errorSpy.mockRestore();
  });

  it('revokes through the control plane and emits machine-readable status', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ok: true,
        data: {
          status: 'revoked',
          subject: 'noodle:google-workload:identity-1',
          issuer: 'https://cloud.noodleseed.dev',
          oidcDiscoveryUrl: 'https://cloud.noodleseed.dev/.well-known/openid-configuration',
          jwksUrl: 'https://cloud.noodleseed.dev/.well-known/jwks.json',
          attributeMapping: {},
          attributeCondition: "assertion.tenant_id == 'acme/analytics/prod'",
          createdAt: '2026-07-23T12:00:00.000Z',
          updatedAt: '2026-07-23T12:01:00.000Z',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(await run(['auth', 'google', 'revoke', '--json'], {}, home)).toBe(0);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE' });
    expect(JSON.parse(lines())).toMatchObject({
      ok: true,
      data: { status: 'revoked' },
    });
  });

  it('validates the real Google exchange without calling a business tool', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ok: true,
        checks: [
          {
            connectorId: 'bigquery',
            operation: 'query',
            authKind: 'googleWorkloadIdentity',
            ok: true,
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(await run(['auth', 'google', 'doctor'], {}, home)).toBe(0);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://cloud.noodleseed.dev/v1/orgs/acme/apps/analytics/envs/prod/auth/google-workload-identity/doctor',
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
    expect(lines()).toContain('PASS googleWorkloadIdentity: bigquery.query');
  });
});

function lines(): string {
  return logSpy.mock.calls.map(([line]) => String(line)).join('\n');
}
