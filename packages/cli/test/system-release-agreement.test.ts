import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  organizationAgreementConfig,
  preflightOrganizationAgreement,
  verifyOrganizationAgreement,
} from '../../../scripts/lib/system-release-agreement.mjs';
import { promoteSystemRelease } from '../../../scripts/system-release-promote.mjs';
import {
  businessInformationServiceDeployConfig,
  cloudRunRuntimeConfig,
  cloudRunStampArgs,
  parseCloudRunDescription,
} from '../../../scripts/system-release-runtime-config.mjs';
import { harness, manifest } from './system-release-harness.js';

const html = '<html>Reviewed agreement</html>';
const document = {
  url: 'https://example.test/legal/v1',
  sha256: createHash('sha256').update(html).digest('hex'),
};
const catalog = { version: 'v1', terms: document, privacy: document, processing: document };
const serialized = JSON.stringify(catalog);
it('permits closed bootstrap but never clears an effective catalog by omission', () => {
  expect(organizationAgreementConfig(undefined)).toBe('');
  expect(organizationAgreementConfig('', serialized)).toBe(serialized);
  expect(() =>
    organizationAgreementConfig(
      JSON.stringify({ ...catalog, terms: { ...document, sha256: 'f'.repeat(64) } }),
      serialized,
    ),
  ).toThrow(/version/i);
  expect(() => organizationAgreementConfig('{"version":"v1"}')).toThrow();
});
it('verifies actual bounded exact document bytes before signup opens', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response(html));
  // Each request needs a fresh response stream.
  fetchImpl.mockImplementation(async () => new Response(html));
  await verifyOrganizationAgreement(serialized, fetchImpl);
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
  await expect(verifyOrganizationAgreement('', fetchImpl)).rejects.toThrow(/required/i);
  await expect(
    verifyOrganizationAgreement(serialized, async () => new Response('changed')),
  ).rejects.toThrow(/digest/i);
  await expect(
    verifyOrganizationAgreement(serialized, async () => new Response('', { status: 503 })),
  ).rejects.toThrow();
  await expect(
    verifyOrganizationAgreement(serialized, async () => new Response('x'.repeat(1048577))),
  ).rejects.toThrow(/bound/i);
});
it('captures the catalog and preserves live authority during image rollback', () => {
  const state = parseCloudRunDescription(
    {
      spec: {
        template: {
          spec: {
            containers: [
              {
                image: `registry/service@sha256:${'a'.repeat(64)}`,
                env: [{ name: 'NOODLE_ORGANIZATION_AGREEMENT', value: serialized }],
              },
            ],
          },
        },
      },
    },
    ['spec', 'template', 'spec', 'containers'],
  );
  expect(state.organizationAgreement).toBe(serialized);
  expect(
    cloudRunRuntimeConfig('service', 'promote', {}, { organizationAgreement: serialized }),
  ).toHaveProperty('NOODLE_ORGANIZATION_AGREEMENT', serialized);
  expect(
    cloudRunRuntimeConfig(
      'service',
      'rollback',
      { organizationAgreement: 'old' },
      { organizationAgreement: serialized },
    ),
  ).not.toHaveProperty('NOODLE_ORGANIZATION_AGREEMENT');
  const args = cloudRunStampArgs({}, { NOODLE_ORGANIZATION_AGREEMENT: serialized });
  expect(args[1]).toContain(serialized);
});
it('includes the catalog in a JSON-safe preproduction gcloud dictionary', () => {
  const config = businessInformationServiceDeployConfig(
    {
      PORTAL_SERVICE_ACCOUNT: 'portal-run@example.iam.gserviceaccount.com',
      PUBLIC_BASE_URL: 'https://service.example.com',
      NOODLE_PORTAL_URL: 'https://portal.example.com',
      NOODLE_OAUTH_PORTAL_CLIENT_ID: 'portal-client',
      PORTAL_AUTH_SECRET_SECRET: 'portal-auth',
      PORTAL_AUTH_SECRET_VERSION: '1',
      NOODLE_BUSINESS_SOURCE_IDENTITY_KEY_SECRET: 'source-identity',
      NOODLE_BUSINESS_SOURCE_IDENTITY_KEY_VERSION: '2',
      NOODLE_ORGANIZATION_AGREEMENT: serialized,
    },
    {},
    { NOODLE_PRODUCT_ANALYTICS_ENABLED: 'true' },
  );
  expect(config.envVars).toMatch(/^\^.+\^/);
  expect(config.envVars).toContain(`NOODLE_ORGANIZATION_AGREEMENT=${serialized}`);
  expect(config.envVars).toContain('NOODLE_PRODUCT_ANALYTICS_ENABLED=true');
});

it('fails document preflight before any hosted mutation', async () => {
  const h = harness({ failAt: 'preflight:agreement' });
  await expect(
    promoteSystemRelease({ manifest: manifest(), publish: [] }, h.adapter),
  ).rejects.toThrow();
  expect(h.deployments).toHaveLength(0);
});
it('restores code without downgrading the agreement already made effective', async () => {
  const h = harness({ failAt: 'promote:docs' });
  h.state.service.organizationAgreement = JSON.stringify({ ...catalog, version: 'old' });
  h.adapter.verifyBusinessOnboarding = async () => serialized;
  const deploy = h.adapter.deploy;
  h.adapter.deploy = async (...args) => {
    await deploy(...args);
    if (args[0] === 'service' && args[3] === 'promote')
      h.state.service.organizationAgreement = serialized;
  };
  await expect(
    promoteSystemRelease({ manifest: manifest(), publish: [] }, h.adapter),
  ).rejects.toThrow();
  expect(h.state.service.organizationAgreement).toBe(serialized);
  expect(h.calls).toContain('capture:before-rollback');
  expect(h.calls).toContain('rollback:service');
});

it('allows only observed-empty closed bootstrap without fetching unavailable future documents', async () => {
  const fetchImpl = vi.fn();
  expect(await preflightOrganizationAgreement('', '', fetchImpl)).toBe('');
  expect(fetchImpl).not.toHaveBeenCalled();
  await expect(preflightOrganizationAgreement('', undefined, fetchImpl)).rejects.toThrow(
    /observed/i,
  );
  fetchImpl.mockImplementation(async () => new Response(html));
  expect(await preflightOrganizationAgreement('', serialized, fetchImpl)).toBe(serialized);
  expect(fetchImpl).toHaveBeenCalledTimes(3);
});
it('keeps the first release business entry closed and opens it only in the verified later release', async () => {
  const h = harness();
  h.adapter.organizationAgreement = '';
  h.adapter.verifyBusinessOnboarding = async () => '';
  await promoteSystemRelease({ manifest: manifest(), publish: [] }, h.adapter);
  expect(h.state.website.websitePortalUrl).toBe('');
  expect(h.calls).not.toContain('activate-signup:website');
  h.adapter.verifyBusinessOnboarding = async () => serialized;
  const deploy = h.adapter.deploy;
  h.adapter.deploy = async (...args) => {
    await deploy(...args);
    if (args[0] === 'service' && args[3] !== 'rollback')
      h.state.service.organizationAgreement = serialized;
  };
  await promoteSystemRelease({ manifest: manifest(), publish: [] }, h.adapter);
  expect(h.state.website.websitePortalUrl).toBe('https://portal.example.test');
});
it('does not treat an opaque catalog secret reference as proof of absent live authority', () => {
  expect(() =>
    parseCloudRunDescription(
      {
        spec: {
          template: {
            spec: {
              containers: [
                {
                  image: `registry/service@sha256:${'a'.repeat(64)}`,
                  env: [
                    {
                      name: 'NOODLE_ORGANIZATION_AGREEMENT',
                      valueFrom: { secretKeyRef: { name: 'catalog', key: '1' } },
                    },
                  ],
                },
              ],
            },
          },
        },
      },
      ['spec', 'template', 'spec', 'containers'],
    ),
  ).toThrow(/catalog/i);
});
