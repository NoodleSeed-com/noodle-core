import { compileManifest, InMemoryCatalog } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { StaticServiceBroker } from '../src/broker/static.js';
import { resolveVariableEnvironment } from '../src/business-variables.js';
import { executePreparedTool, prepareToolForConfirmation } from '../src/confirmation.js';
import { InMemoryConnectorRegistry } from '../src/connector/in-memory.js';
import { executeTool } from '../src/execute.js';

function fixture(withDefault = false) {
  const result = compileManifest(
    {
      manifestVersion: '2',
      server: {
        name: 'app',
        title: 'App',
        version: '1',
        variables: [
          {
            name: 'DAYS',
            schemaVersion: 1,
            valueSchema: {
              type: 'array',
              maxItems: 7,
              items: { type: 'string', enum: ['mon', 'tue'] },
            },
            ...(withDefault ? { default: ['mon'] } : {}),
            requiredFor: ['book'],
          },
          {
            name: 'ENABLED',
            schemaVersion: 1,
            valueSchema: { type: 'boolean' },
            default: false,
            requiredFor: [],
          },
        ],
      },
      tools: [
        {
          name: 'book',
          description: 'Book.',
          inputSchema: { type: 'object' },
          fulfilment: {
            steps: [],
            output: {
              days: '${env.DAYS}',
              enabled: '${env.ENABLED}',
              technical: '${env.TECHNICAL}',
            },
          },
        },
        {
          name: 'lead',
          description: 'Save a lead.',
          inputSchema: { type: 'object' },
          fulfilment: { steps: [], output: { ok: true } },
        },
      ],
    },
    { catalog: new InMemoryCatalog([]) },
  );
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.artifact;
}
const deps = { connectors: new InMemoryConnectorRegistry([]), broker: new StaticServiceBroker({}) };

describe('typed business variable runtime', () => {
  it('decodes canonical JSON and keeps technical strings literal', async () => {
    const result = await executeTool(
      fixture(),
      'book',
      {},
      { ...deps, env: { DAYS: '["tue"]', ENABLED: 'false', TECHNICAL: 'false' } },
    );
    expect(result).toEqual({
      ok: true,
      output: { days: ['tue'], enabled: false, technical: 'false' },
    });
  });
  it('resolves defaults without mutating the declaration', () => {
    const artifact = fixture(true);
    const result = resolveVariableEnvironment(artifact.server.variables ?? [], {});
    expect(result).toMatchObject({ ok: true, env: { DAYS: ['mon'], ENABLED: false }, missing: [] });
  });
  it('gates only dependent tools before dispatch', async () => {
    expect(await executeTool(fixture(), 'book', {}, deps)).toMatchObject({
      ok: false,
      error: { code: 'configuration_required' },
    });
    expect(await executeTool(fixture(), 'lead', {}, deps)).toEqual({
      ok: true,
      output: { ok: true },
    });
  });
  it.each([
    'false',
    '["wed"]',
    'not-json',
  ])('rejects invalid declared data %s without leaking it', async (raw) => {
    const result = await executeTool(fixture(), 'book', {}, { ...deps, env: { DAYS: raw } });
    expect(result).toMatchObject({ ok: false, error: { code: 'configuration_invalid' } });
    if (!result.ok) expect(JSON.stringify(result.error)).not.toContain(raw);
  });
  it('rejects changed business settings after confirmation without executing old intent', async () => {
    const artifact = fixture();
    const prepared = await prepareToolForConfirmation(
      artifact,
      'book',
      {},
      { ...deps, env: { DAYS: '["mon"]' } },
    );
    expect(prepared.status).toBe('confirmation_required');
    if (prepared.status !== 'confirmation_required') return;
    const result = await executePreparedTool(artifact, prepared.continuation, {
      ...deps,
      env: { DAYS: '["tue"]' },
    });
    expect(result).toMatchObject({ status: 'failed', error: { code: 'configuration_changed' } });
  });
});
