import { compileManifest, InMemoryCatalog, type Manifest } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { StaticServiceBroker } from '../src/broker/static.js';
import { InMemoryConnectorRegistry } from '../src/connector/in-memory.js';
import { type ExecuteDeps, executeTool } from '../src/execute.js';

function deps(env: Record<string, string> = {}): ExecuteDeps {
  return {
    connectors: new InMemoryConnectorRegistry([]),
    broker: new StaticServiceBroker({ token: '' }),
    env: async () => env,
  };
}

describe('runtime env expression root', () => {
  it('allows fulfilment expressions to read hierarchical non-secret variables from env', async () => {
    const compiled = compileManifest(
      {
        manifestVersion: '1',
        server: { name: 'vars', version: '1.0.0', title: 'Variables' },
        tools: [
          {
            name: 'show',
            description: 'Show variable values.',
            inputSchema: { type: 'object', additionalProperties: false },
            fulfilment: {
              steps: [],
              output: {
                region: '${env.REGION}',
              },
            },
          },
        ],
      } as Manifest,
      { catalog: new InMemoryCatalog([]) },
    );

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    await expect(
      executeTool(compiled.artifact, 'show', {}, deps({ REGION: 'us' })),
    ).resolves.toEqual({
      ok: true,
      output: { region: 'us' },
    });
  });
});
