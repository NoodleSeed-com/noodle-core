import { describe, expect, it } from 'vitest';
import {
  cspFaultsInManifest,
  cspOriginFaults,
  isHonorableCspOrigin,
} from '../src/manifest/csp-origins.js';

// The canonical rule mirrors the first-party host renderer's `isSafeOrigin`
// (apps/console/app/lib/mcp/widget-host.ts): an honorable CSP source is an absolute https:// origin
// (or http:// for localhost/127.0.0.1). Anything the host would silently drop is a fault. The parity
// vectors below are the shared spec — the console host test asserts the same set.
const HONORABLE = [
  'https://api.example.com',
  'https://api.example.com:8443',
  'https://sub.deep.example.com',
  'http://localhost',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
];
const UNHONORABLE = [
  'api.example.com', // scheme-less: new URL() throws -> host drops it
  '*.example.com', // wildcard: not URL-parseable
  'http://api.example.com', // non-local http is dropped
  'javascript:alert(1)',
  'data:text/html,x',
  'ftp://example.com',
  '',
];

describe('isHonorableCspOrigin', () => {
  it('accepts absolute https and localhost http origins', () => {
    for (const value of HONORABLE) expect(isHonorableCspOrigin(value), value).toBe(true);
  });
  it('rejects scheme-less, wildcard, non-local http, and dangerous schemes', () => {
    for (const value of UNHONORABLE) expect(isHonorableCspOrigin(value), value).toBe(false);
  });
});

describe('cspOriginFaults', () => {
  it('flags unhonorable origins across the honored lists with a widget-scoped location', () => {
    const faults = cspOriginFaults([
      {
        name: 'cart',
        csp: {
          connectDomains: ['https://ok.example.com', 'api.example.com'],
          resourceDomains: ['*.cdn.example.com'],
          frameDomains: ['https://frame.example.com'],
        },
      },
    ]);
    expect(faults).toHaveLength(2);
    expect(faults.map((f) => f.value).sort()).toEqual(['*.cdn.example.com', 'api.example.com']);
    const connect = faults.find((f) => f.list === 'connectDomains');
    expect(connect).toMatchObject({
      widget: 'cart',
      index: 1,
      suggestion: 'https://api.example.com',
    });
  });

  it('does not gate on csp keys outside the honored lists (e.g. the dropped baseUriDomains)', () => {
    const faults = cspOriginFaults([
      { name: 'cart', csp: { baseUriDomains: ['api.example.com'] } },
    ]);
    expect(faults).toHaveLength(0);
  });

  it('returns nothing for a clean widget or a widget with no csp', () => {
    expect(
      cspOriginFaults([{ name: 'a', csp: { connectDomains: ['https://ok.example.com'] } }]),
    ).toEqual([]);
    expect(cspOriginFaults([{ name: 'b' }])).toEqual([]);
    expect(cspOriginFaults(undefined)).toEqual([]);
  });
});

describe('cspFaultsInManifest', () => {
  it('reports honored-list faults from a JSON manifest', () => {
    const manifest = JSON.stringify({
      server: { name: 'shop' },
      widgets: [{ name: 'cart', tool: 'open_cart', csp: { connectDomains: ['api.example.com'] } }],
    });
    const faults = cspFaultsInManifest(manifest);
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({
      widget: 'cart',
      list: 'connectDomains',
      value: 'api.example.com',
    });
  });

  it('reports faults from a YAML manifest too (the deploy route accepts both)', () => {
    const manifest = [
      'server:',
      '  name: shop',
      'widgets:',
      '  - name: cart',
      '    tool: open_cart',
      '    csp:',
      '      connectDomains:',
      '        - api.example.com',
    ].join('\n');
    const faults = cspFaultsInManifest(manifest);
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({
      widget: 'cart',
      list: 'connectDomains',
      value: 'api.example.com',
    });
  });

  it('is tolerant of unparseable or widget-less manifests (compile owns that error)', () => {
    expect(cspFaultsInManifest('{ : : not valid')).toEqual([]);
    expect(cspFaultsInManifest(JSON.stringify({ server: { name: 'x' } }))).toEqual([]);
  });

  it('parses JSON manifests with JSON semantics (a duplicate key is last-wins, not a YAML error)', () => {
    // Duplicate keys are invalid strict YAML but last-wins JSON. The deploy route sends the
    // CLI's JSON manifests through here, and those must never pay the YAML parser's multi-
    // hundred-megabyte transient cost on a multi-megabyte document (it OOM-killed a 512MiB
    // production instance), so JSON documents take the JSON.parse path.
    const manifest =
      '{"server":{"name":"shop","name":"shop"},' +
      '"widgets":[{"name":"cart","tool":"open_cart","csp":{"connectDomains":["api.example.com"]}}]}';
    const faults = cspFaultsInManifest(manifest);
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({ widget: 'cart', value: 'api.example.com' });
  });
});
