import { resolveInvocationContextSnapshot } from '@noodle-borg/assistant-gateway/portable';
import { compile, InMemoryCatalog } from '@noodle-borg/compiler';
import type { CallerIdentity, ConnectorRegistry, CredentialBroker } from '@noodle-borg/runtime';
import { describe, expect, it } from 'vitest';

// An anonymous principal can never satisfy a delegated-auth fulfilment: the broker exchange is
// guaranteed to fail. Every anonymous turn on such a deployment paid one doomed token-exchange
// round trip before degrading to ambientStatus 'unavailable'; the resolver now skips it.

const MANIFEST = `
manifestVersion: "2"
server:
  name: teams_assistant
  version: 1.0.0
  title: Teams assistant
  context:
    ambient:
      outputSchema:
        type: object
        properties:
          defaultTeamId: { type: string }
        required: [defaultTeamId]
        additionalProperties: false
      fulfilment:
        use: crm.get_teams
        args: {}
connectors:
  crm:
    id: crm_connector
    version: 1.0.0
tools:
  - name: ping
    description: Ping.
    inputSchema:
      type: object
      additionalProperties: false
    annotations:
      readOnlyHint: true
      destructiveHint: false
      openWorldHint: false
    fulfilment:
      steps: []
      output:
        ok: true
`;

const catalog = new InMemoryCatalog([
  {
    id: 'crm_connector',
    version: '1.0.0',
    kind: 'catalog',
    operations: {
      get_teams: {
        type: 'read',
        input: { type: 'object', additionalProperties: false },
        output: {
          type: 'object',
          properties: { defaultTeamId: { type: 'string' } },
          required: ['defaultTeamId'],
          additionalProperties: false,
        },
      },
    },
  },
]);

function compiledArtifact() {
  const result = compile(MANIFEST, { catalog });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.errors.map((error) => error.message).join('; '));
  return result.artifact;
}

/** Deps whose connector registry records whether execution was ever attempted. */
function spyingDeps(delegatedKeys?: ReadonlySet<string>) {
  let touched = 0;
  const connectors: ConnectorRegistry = {
    resolve() {
      touched += 1;
      return undefined; // Attempt observed; resolution fails gracefully (connector_unavailable).
    },
  };
  const broker = {
    ...(delegatedKeys === undefined ? {} : { assistantDelegatedAuthKeys: () => delegatedKeys }),
  } as unknown as CredentialBroker;
  return { deps: { connectors, broker }, touched: () => touched };
}

const ANONYMOUS: CallerIdentity = { subject: 'anon-1', identityKind: 'anonymous' };
const CUSTOMER: CallerIdentity = { subject: 'user-1', identityKind: 'customer' };

describe('anonymous callers and delegated-auth ambient context', () => {
  it('skips the doomed exchange: unavailable without touching the connector plane', async () => {
    const spy = spyingDeps(new Set(['crm_connector|get_teams']));
    const context = await resolveInvocationContextSnapshot({
      artifact: compiledArtifact(),
      executeDeps: spy.deps,
      caller: ANONYMOUS,
      instant: new Date('2030-01-01T00:00:00Z'),
    });
    expect(context.ambientStatus).toBe('unavailable');
    expect(spy.touched()).toBe(0);
  });

  it('still attempts ambient resolution for identified callers', async () => {
    const spy = spyingDeps(new Set(['crm_connector|get_teams']));
    const context = await resolveInvocationContextSnapshot({
      artifact: compiledArtifact(),
      executeDeps: spy.deps,
      caller: CUSTOMER,
      instant: new Date('2030-01-01T00:00:00Z'),
    });
    expect(context.ambientStatus).toBe('unavailable');
    expect(spy.touched()).toBeGreaterThan(0);
  });

  it('still attempts ambient resolution for anonymous callers when the provider is not delegated', async () => {
    const spy = spyingDeps(new Set());
    const context = await resolveInvocationContextSnapshot({
      artifact: compiledArtifact(),
      executeDeps: spy.deps,
      caller: ANONYMOUS,
      instant: new Date('2030-01-01T00:00:00Z'),
    });
    expect(context.ambientStatus).toBe('unavailable');
    expect(spy.touched()).toBeGreaterThan(0);
  });
});
