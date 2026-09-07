import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryControlPlaneStore } from '@noodle-borg/control-plane/portable';
import { MODULE_API_VERSION, type ServiceModule } from '@noodle-borg/module';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';
import { serveService } from '../src/serve.js';

/** Same public ModuleContributions seam used by an operator's private service composition. */
const historyPolicy: ServiceModule = {
  name: 'operator-history-policy',
  version: '1.0.0',
  apiVersion: MODULE_API_VERSION,
  init: () => ({
    resolveActivityHistoryAllowance: async (org) =>
      org === 'acme'
        ? { maximumDays: 30, defaultDays: 30, revision: 'operator-policy-v1' }
        : undefined,
  }),
};

describe('self-host native actions without commercial modules', () => {
  it('uses explicit operator custody policy for installation, MCP write and Activity, and fails closed without it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'noodle-private-native-'));
    const controlPlane = new InMemoryControlPlaneStore();
    await controlPlane.createOrgWithOwner({
      slug: 'acme',
      owner: { subject: 'owner', email: 'owner@example.com' },
    });
    const business = new InMemoryBusinessInformationStore();
    let configured = true;
    const allowance = vi.fn(async (org: string, options?: { includePreview: true }) =>
      configured && org === 'acme'
        ? {
            maximumDays: 30,
            defaultDays: 30,
            revision: 'operator-policy-v1',
            ...(options?.includePreview
              ? {
                  preview: {
                    asOf: new Date().toISOString(),
                    paidPeriodEnd: new Date(Date.now() + 10 * 86_400_000).toISOString(),
                    scenarios: [{ id: 'shorter', label: 'Shorter window', maximumDays: 7 }],
                  },
                }
              : {}),
          }
        : undefined,
    );
    const service = await serveService({
      host: '127.0.0.1',
      port: 0,
      serviceConfigDir: dir,
      controlPlaneStore: controlPlane,
      businessInformationStore: business,
      businessInformationEnabled: true,
      modules: [
        {
          ...historyPolicy,
          init: () => ({
            resolveActivityHistoryAllowance: allowance,
          }),
        },
      ],
      deployGate: {
        authorize: async () => ({
          ok: true,
          identity: { subject: 'owner', email: 'owner@example.com', superAdmin: false },
        }),
      },
    });
    try {
      const installation = await fetch(`${service.url}/v1/orgs/acme/solution-installations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          definition: { kind: 'managed', profileId: 'travel' },
          appSlug: 'travel',
          environment: 'prod',
          retentionDays: 30,
        }),
      });
      expect(installation.status, await installation.clone().text()).toBe(201);
      const { data } = (await installation.json()) as { data: { installation: { id: string } } };
      const call = (id: number) =>
        fetch(`${service.url}/o/acme/travel/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2025-11-25',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: {
              name: 'submit_travel_request',
              arguments: { request_type: 'service', summary: 'Please review my itinerary.' },
            },
          }),
        });
      const readiness = await fetch(
        `${service.url}/v1/orgs/acme/solution-installations/${data.installation.id}/activity/settings`,
      );
      expect(readiness.status, await readiness.clone().text()).toBe(200);
      const target = await service.registry.getActiveByTenant({
        org: 'acme',
        app: 'travel',
        env: 'prod',
      });
      const native = target?.served.deps.connectors.resolve({
        connectorId: 'noodle_records',
        connectorVersion: '1.0.0',
        operation: 'submit_record',
      });
      expect(native?.executionBoundMs?.('submit_record')).toBe(10000);
      const response = await call(1);
      const body = await response.text();
      expect(response.status, body).toBe(200);
      expect(body).toContain('recordId');
      expect(body).not.toContain('"isError":true');
      const scope = {
        org: 'acme',
        app: 'travel',
        env: 'prod',
        installationId: data.installation.id,
      };
      expect(
        (await business.listRequests({ scope, collectionKey: 'travel_requests' })).records,
      ).toHaveLength(1);
      const activity = await fetch(
        `${service.url}/v1/orgs/acme/solution-installations/${data.installation.id}/activity`,
      );
      expect(activity.status, await activity.clone().text()).toBe(200);
      expect(await activity.json()).toMatchObject({
        data: {
          activities: [{ outcome: 'completed', tool: 'submit_travel_request' }],
          historyDays: 30,
        },
      });
      const preview = await fetch(
        `${service.url}/v1/orgs/acme/solution-installations/${data.installation.id}/activity/preview`,
      );
      expect(preview.status, await preview.clone().text()).toBe(200);
      expect(await preview.json()).toMatchObject({
        data: {
          state: 'available',
          kind: 'hypothetical',
          currentMaximumDays: 30,
          currentlyAccessibleCount: 1,
          scenarios: [{ id: 'shorter', maximumDays: 7, additionallyHiddenAtPeriodEndCount: 1 }],
        },
      });
      expect(allowance).toHaveBeenCalledWith('acme', { includePreview: true });
      configured = false;
      const unavailable = await fetch(
        `${service.url}/v1/orgs/acme/solution-installations/${data.installation.id}/activity/settings`,
      );
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toMatchObject({ code: 'activity_unavailable' });
      const refused = await call(2);
      expect(await refused.text()).not.toContain('recordId');
      expect(
        (await business.listRequests({ scope, collectionKey: 'travel_requests' })).records,
      ).toHaveLength(1);
    } finally {
      await service.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
