import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSolutionConnections } from '../src/commands/solutions-connections.js';
import { runSolutions } from '../src/commands/solutions-ops.js';

let home: string;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
const flags = [
  '--org',
  'acme',
  '--service',
  'https://cloud.example.test',
  '--auth-token',
  'fixture-owner',
  '--json',
];
const projection = {
  ok: true,
  data: {
    connections: [
      { id: 'records_account', label: 'Records', state: 'ready', revision: 3, connectable: true },
    ],
    canEdit: true,
  },
};
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-connections-cli-'));
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  log.mockRestore();
  error.mockRestore();
  rmSync(home, { recursive: true, force: true });
});
describe('solutions connections operator projection', () => {
  it('uses the typed list API and strips additive fields', async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ ...projection, data: { ...projection.data, future: 'hidden' } }),
    );
    expect(
      await runSolutions(['connections', 'list', 'installation', ...flags], {}, home, {
        fetchImpl: request,
      }),
    ).toBe(0);
    expect(request.mock.calls[0]?.[0]).toBe(
      'https://cloud.example.test/v1/orgs/acme/solution-installations/installation/connections',
    );
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(projection);
  });
  it('disconnects only the selected connection with an expected revision', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json(projection));
    expect(
      await runSolutionConnections(
        ['disconnect', 'installation', 'records_account', '--expected-revision', '3', ...flags],
        {},
        home,
        { fetchImpl: request },
      ),
    ).toBe(0);
    expect(request.mock.calls[0]?.[0]).toContain('/connections/records_account/disconnect');
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ expectedRevision: 3 }),
    });
    expect(
      await runSolutionConnections(
        ['disconnect', 'installation', 'records_account', ...flags],
        {},
        home,
        { fetchImpl: request },
      ),
    ).toBe(2);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('hands consent to the canonical Portal without fabricating a connected account', async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ ok: true, data: { installation: { appSlug: 'workflow' } } }),
    );
    const open = vi.fn();
    expect(
      await runSolutionConnections(
        ['connect', 'installation', ...flags, '--portal', 'https://business.example.test'],
        {},
        home,
        { fetchImpl: request, open },
      ),
    ).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      data: {
        portalUrl: 'https://business.example.test/o/acme/workflow/integrations',
        status: 'browser_consent_required',
      },
    });
    expect(open).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
    expect(
      await runSolutionConnections(
        ['connect', 'installation', ...flags, '--portal', 'javascript:alert(1)'],
        {},
        home,
        { fetchImpl: request, open },
      ),
    ).toBe(2);
  });
});
