import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compile, InMemoryCatalog } from '@noodle-borg/compiler';
import { compileConnectors } from '@noodle-borg/connector-defs';
import { executeTool, InMemoryConnectorRegistry } from '@noodle-borg/runtime';
import { afterEach, expect, it } from 'vitest';
import { readDeployInput } from '../src/deploy.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('compiles and executes the actual published HTTP connector guide sample', async () => {
  const guide = readFileSync(
    resolve(import.meta.dirname, '../../../apps/docs/content/guides/connectors.mdx'),
    'utf8',
  );
  const source = /```ts title="src\/server.ts"\n([\s\S]*?)\n```/.exec(guide)?.[1];
  expect(source).toBeDefined();
  const root = mkdtempSync(join(tmpdir(), 'noodle-connector-guide-'));
  roots.push(root);
  symlinkSync(
    resolve(import.meta.dirname, '../../../node_modules'),
    join(root, 'node_modules'),
    'dir',
  );
  const path = join(root, 'server.ts');
  writeFileSync(path, source ?? '');
  const input = await readDeployInput(path);
  const document = JSON.parse(input.connectors ?? '') as {
    connectors: Array<{ operations: Record<string, { fake?: { response: unknown } }> }>;
  };
  const operation = document.connectors[0]?.operations.current;
  if (operation === undefined) throw new Error('Expected the guide current operation');
  operation.fake = { response: { temperature: 22 } };
  const connectors = compileConnectors(JSON.stringify(document), { mode: 'fake' });
  expect(connectors.ok, JSON.stringify(connectors)).toBe(true);
  if (!connectors.ok) return;
  const compiled = compile(input.manifest, { catalog: new InMemoryCatalog(connectors.catalog) });
  expect(compiled.ok, JSON.stringify(compiled)).toBe(true);
  if (!compiled.ok) return;
  await expect(
    executeTool(
      compiled.artifact,
      'current_weather',
      { city: 'Fixture' },
      {
        connectors: new InMemoryConnectorRegistry(connectors.connectors),
        broker: { getCredential: async () => ({ token: 'synthetic-test-only' }) },
      },
    ),
  ).resolves.toMatchObject({ ok: true, output: { temp_c: 22 } });
});

it('compiles the published path-parameter fragment without extending expression grammar', async () => {
  const guide = readFileSync(
    resolve(import.meta.dirname, '../../../apps/docs/content/guides/connectors.mdx'),
    'utf8',
  );
  const fragment = /```ts\n(operations: \{[\s\S]*?)\n```/.exec(guide)?.[1];
  expect(fragment).toBeDefined();
  const root = mkdtempSync(join(tmpdir(), 'noodle-path-guide-'));
  roots.push(root);
  symlinkSync(
    resolve(import.meta.dirname, '../../../node_modules'),
    join(root, 'node_modules'),
    'dir',
  );
  const path = join(root, 'server.ts');
  writeFileSync(
    path,
    `import { annotations, connector, server, tool, z } from '@noodleseed/one';
const api = connector('orders').version('1.0.0').http({ baseUrl: 'https://api.example.com', allowedOrigins: ['https://api.example.com'], ${fragment} });
export default server('orders', { title: 'Orders', version: '1.0.0', use: { api } }, [tool('get_order', {
  description: 'Read an order.', annotations: annotations.readOnly({ openWorld: true }),
  input: z.object({ id: z.string() }), output: z.object({ total: z.number() }),
  fulfil: ({ input, connectors }) => ({ total: connectors.api.get_order({ id: input.id }).total }),
})]);`,
  );
  const input = await readDeployInput(path);
  const connectors = compileConnectors(input.connectors ?? '');
  expect(connectors.ok, JSON.stringify(connectors)).toBe(true);
  if (!connectors.ok) return;
  expect(compile(input.manifest, { catalog: new InMemoryCatalog(connectors.catalog) }).ok).toBe(
    true,
  );
});
