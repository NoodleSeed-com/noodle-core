import { ARTIFACT_SCHEMA_VERSION, type RuntimeArtifact } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import type { SolutionInstallation } from '../src/business-information/contracts.js';
import { capabilityReport } from '../src/channels/capability-report.js';

const tenant = { org: 'acme', app: 'site', env: 'prod' };
const IDENTITY = { capability: 'account_self_service', status: 'unavailable' };

function artifact(options: { knowledge?: boolean; collect?: boolean } = {}): RuntimeArtifact {
  return {
    artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
    resolution: 'resolved',
    source: { manifestName: 'site', manifestVersion: '1.0.0', coreVersion: '2' },
    server: {
      name: 'site',
      version: '1.0.0',
      title: 'Acme',
      ...(options.knowledge ? { knowledge: [{ name: 'product' } as never] } : {}),
    },
    tools: [
      {
        name: 'identity',
        description: 'Who we are.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
        fulfilment: { kind: 'flow', steps: [], output: {} },
      },
      ...(options.collect
        ? [
            {
              name: 'open_contact_form',
              description: 'Opener.',
              inputSchema: { type: 'object', properties: {} },
              annotations: { readOnlyHint: true },
              fulfilment: { kind: 'flow' as const, steps: [], output: {} },
            },
            {
              name: 'submit_enquiry',
              description: 'Action.',
              inputSchema: { type: 'object', properties: { fullName: { type: 'string' } } },
              annotations: { readOnlyHint: false, confirm: true },
              fulfilment: {
                kind: 'flow' as const,
                steps: [
                  {
                    id: 'saved',
                    kind: 'operation' as const,
                    operationRef: {
                      resolved: false as const,
                      connector: 'records',
                      operation: 'submit_record',
                    },
                    args: { collection: { kind: 'literal' as const, value: 'leads' } },
                  },
                ],
                output: {},
              },
            },
          ]
        : []),
    ],
    capabilities: { tools: [] },
    ...(options.collect
      ? {
          toolInteractions: {
            open_contact_form: {
              kind: 'collect',
              action: 'submit_enquiry',
              fields: [{ key: 'fullName', control: 'text' }],
              review: 'all',
              outcome: { success: 'Saved.' },
            },
          },
        }
      : {}),
  };
}
const installation = (overrides: Partial<SolutionInstallation> = {}): SolutionInstallation =>
  ({
    scope: { ...tenant, installationId: 'site-prod' },
    managedCollections: ['leads'],
    definition: { collections: [{ key: 'leads' }] },
    intakeActive: true,
    ...overrides,
  }) as SolutionInstallation;
const installations = (...items: SolutionInstallation[]) => ({
  listInstallations: async () => items,
});

describe('WhatsApp capability report', () => {
  it('derives only what the selected tools imply and always states the identity gap', async () => {
    expect(
      await capabilityReport({
        artifact: artifact(),
        tenant,
        durable: true,
        installations: installations(),
      }),
    ).toEqual([
      { capability: 'look_up_information', status: 'native' },
      expect.objectContaining({
        ...IDENTITY,
        code: 'IDENTITY_NOT_ESTABLISHABLE',
        requirement: 'verified_customer',
      }),
    ]);
    expect(
      await capabilityReport({
        artifact: artifact({ knowledge: true }),
        tenant,
        durable: true,
        installations: undefined,
      }),
    ).toEqual([
      { capability: 'answer_questions', status: 'native' },
      { capability: 'look_up_information', status: 'native' },
      expect.objectContaining(IDENTITY),
    ]);
    expect(
      await capabilityReport({
        artifact: undefined,
        tenant,
        durable: true,
        installations: undefined,
      }),
    ).toEqual([expect.objectContaining(IDENTITY)]);
  });
  it('reports capture as native only when custody is durable and the collection is installed and open', async () => {
    const capture = async (durable: boolean, ...items: SolutionInstallation[]) =>
      (
        await capabilityReport({
          artifact: artifact({ collect: true }),
          tenant,
          durable,
          installations: installations(...items),
        })
      ).find((entry) => entry.capability === 'capture_request');
    expect(await capture(true, installation())).toEqual({
      capability: 'capture_request',
      status: 'native',
    });
    expect(await capture(false, installation())).toMatchObject({
      status: 'needs_setup',
      code: 'durable_storage_required',
      requirement: 'durable_interaction_store',
    });
    expect(await capture(true)).toMatchObject({
      status: 'needs_setup',
      code: 'collection_not_installed',
      requirement: 'collection_installation',
    });
    expect(await capture(true, installation({ managedCollections: [] }))).toMatchObject({
      code: 'collection_not_installed',
      next: expect.stringContaining('"leads"'),
    });
    expect(await capture(true, installation({ intakeActive: false }))).toMatchObject({
      status: 'needs_setup',
      code: 'intake_inactive',
      requirement: 'public_intake',
    });
    const report = await capabilityReport({
      artifact: artifact({ collect: true }),
      tenant,
      durable: true,
      installations: undefined,
    });
    expect(report.map((entry) => entry.capability)).toEqual([
      'look_up_information',
      'capture_request',
      'account_self_service',
    ]);
    expect(report[1]).toMatchObject({ code: 'business_information_unavailable' });
  });
});
