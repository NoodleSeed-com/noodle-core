import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runBillingCatalog } from '../src/commands/billing-catalog-ops.js';

describe('billing catalog CLI', () => {
  it('uses the typed status route and rejects invalid release files before network activity', async () => {
    const home = mkdtempSync(join(tmpdir(), 'noodle-catalog-cli-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          data: { version: 1, readerVersion: 2, revision: null, future: true },
        }),
      ),
    );
    const env = { NOODLE_SERVICE_URL: 'https://service.example', NOODLE_AUTH_TOKEN: 'test' };
    try {
      expect(await runBillingCatalog(['status', '--json'], env, home, fetchImpl)).toBe(0);
      expect(fetchImpl.mock.calls[0]?.[0]).toBe(
        'https://service.example/v1/billing-accounts/catalog',
      );
      fetchImpl.mockClear();
      const file = join(home, 'proof.json');
      writeFileSync(file, '{"maximumDays":365}');
      expect(
        await runBillingCatalog(['activate', '--proof', file, '--json'], env, home, fetchImpl),
      ).not.toBe(0);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
