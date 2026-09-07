import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEVELOPER_MCP_CAPABILITY_VERSION } from '@noodle-borg/developer-mcp';
import { afterEach, describe, expect, it } from 'vitest';
import { ServerRegistry } from '../src/registry.js';
import { createServiceHandler } from '../src/service.js';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function listen(developerMcp: boolean): Promise<string> {
  const server = createServer(
    createServiceHandler(new ServerRegistry(), {
      developerMcp,
      buildInfo: { version: '1.2.3', gitSha: 'abc', buildTime: 'now' },
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(
    () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('developer plugin service metadata', () => {
  it('advertises the exact Developer MCP capability only when that endpoint is enabled', async () => {
    const enabled = await listen(true);
    expect(await (await fetch(`${enabled}/v1/service/info`)).json()).toEqual({
      ok: true,
      status: 'ok',
      version: '1.2.3',
      gitSha: 'abc',
      buildTime: 'now',
      developerPlugin: { mcpCapabilityVersion: DEVELOPER_MCP_CAPABILITY_VERSION },
    });

    const disabled = await listen(false);
    expect(await (await fetch(`${disabled}/v1/service/info`)).json()).not.toHaveProperty(
      'developerPlugin',
    );
  });
});
