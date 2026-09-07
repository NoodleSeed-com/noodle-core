/**
 * Characterization lock for the service's HTTP route surface (ADR 0203 carve-out).
 *
 * The service is a hand-rolled dispatcher, not an Express route table: `createServiceHandler`
 * matches requests through ~45 `parse*Path` functions. Nothing else in the suite would notice if
 * an endpoint quietly stopped matching while code moved between packages, so this file snapshots
 * the whole surface: for a corpus of representative URLs, which parsers claim them and what they
 * return.
 *
 * Two properties make it self-maintaining rather than a snapshot that rots:
 *
 * 1. The parser list is read from the modules' *exports*, not hard-coded — deleting or renaming a
 *    parser changes the snapshot.
 * 2. Every exported parser must be claimed by at least one corpus URL, so adding a route without
 *    adding coverage fails here instead of silently shipping unlocked.
 *
 * When a route legitimately changes, the snapshot diff is the review artifact. Module-owned
 * routes are characterized in their owning package rather than retained in this public surface.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as paths from '../src/routes/paths.js';
import * as servicePrincipalPaths from '../src/routes/service-principal-paths.js';

type PathParser = (pathname: string) => unknown;

/**
 * Exported `parse*Path` functions that take only a pathname. `parseConfigPath`'s second parameter
 * is optional so it still reports arity 1; `parseTenantActionPath` requires an action and is
 * locked separately below.
 */
function collectParsers(module: Record<string, unknown>, source: string) {
  return Object.entries(module)
    .filter(
      (entry): entry is [string, PathParser] =>
        /^parse[A-Za-z]*Path$/.test(entry[0]) &&
        typeof entry[1] === 'function' &&
        (entry[1] as PathParser).length === 1,
    )
    .map(([name, parse]) => ({ name, parse, source }));
}

const PARSERS = [
  ...collectParsers(paths as Record<string, unknown>, 'routes/paths.ts'),
  ...collectParsers(
    servicePrincipalPaths as Record<string, unknown>,
    'routes/service-principal-paths.ts',
  ),
].sort((a, b) => a.name.localeCompare(b.name));

const ORG = 'acme';
const APP = 'shop';
const ENV = 'prod';
const TENANT = `/v1/orgs/${ORG}/apps/${APP}/envs/${ENV}`;
const ALERT_RULE = '0f8fad5b-d9cb-469f-a165-70867728950e';
const PRINCIPAL = 'spn_0f8fad5b-d9cb-469f-a165-70867728950e';
const CREDENTIAL = 'spc_0f8fad5b-d9cb-469f-a165-70867728950e';
const GRANT = 'spg_0f8fad5b-d9cb-469f-a165-70867728950e';
const PRINCIPALS = `/v1/orgs/${ORG}/service-principals`;

/** One representative URL per route family the dispatcher serves. */
const CORPUS: readonly string[] = [
  `/v1/orgs/${ORG}`,
  `/v1/orgs/${ORG}/members`,
  `/v1/orgs/${ORG}/members/user_123`,
  `/v1/orgs/${ORG}/invitations`,
  `/v1/orgs/${ORG}/domains`,
  `/v1/orgs/${ORG}/audit/events`,
  `/v1/orgs/${ORG}/openai-apps-challenge`,
  `/v1/orgs/${ORG}/mcp-subdomain`,
  `/v1/orgs/${ORG}/deployments`,
  `/v1/orgs/${ORG}/deployments/dep-01`,
  `/v1/orgs/${ORG}/deployments/dep-01/package`,
  `/v1/orgs/${ORG}/apps`,
  `/v1/orgs/${ORG}/apps/${APP}`,
  `/v1/orgs/${ORG}/apps/${APP}/archive`,
  `/v1/orgs/${ORG}/apps/${APP}/restore`,
  `/v1/orgs/${ORG}/apps/${APP}/envs`,
  `/v1/orgs/${ORG}/apps/${APP}/github/connection`,
  `/v1/orgs/${ORG}/apps/${APP}/github/runs`,
  `/v1/github/runs/run-01/status`,
  `/v1/github/runs/run-01/claim`,
  TENANT,
  `${TENANT}/deploy`,
  `${TENANT}/deploy/preflight`,
  `${TENANT}/deployment-lock`,
  `${TENANT}/status`,
  `${TENANT}/access`,
  `${TENANT}/rollback`,
  `${TENANT}/inspect`,
  `${TENANT}/smoke`,
  `${TENANT}/logs`,
  `${TENANT}/metrics`,
  `${TENANT}/events`,
  `${TENANT}/assistant/usage`,
  `${TENANT}/intent-capture`,
  `${TENANT}/intents`,
  `${TENANT}/alerts`,
  `${TENANT}/alerts/${ALERT_RULE}`,
  `${TENANT}/alerts/${ALERT_RULE}/test`,
  `${TENANT}/assets/preflight`,
  `${TENANT}/auth/doctor`,
  `${TENANT}/auth/google-workload-identity`,
  `${TENANT}/auth/google-workload-identity/doctor`,
  `${TENANT}/sessions/sess-01`,
  `${TENANT}/config`,
  `/v1/orgs/${ORG}/apps/${APP}/production-environment`,
  // Service principals: five path kinds off one parser.
  PRINCIPALS,
  `${PRINCIPALS}/${PRINCIPAL}`,
  `${PRINCIPALS}/${PRINCIPAL}/credentials`,
  `${PRINCIPALS}/${PRINCIPAL}/credentials/${CREDENTIAL}`,
  `${PRINCIPALS}/${PRINCIPAL}/grants`,
  `${PRINCIPALS}/${PRINCIPAL}/grants/${GRANT}`,
  // Negative controls: nothing may claim these.
  '/v1/orgs',
  '/v1/orgs/acme/apps/shop/envs/prod/../../../etc/passwd',
  '/healthz',
  '/',
];

const HOSTILE_SEGMENTS = [
  '',
  '.',
  '..',
  '%',
  '%0',
  '%GG',
  '%00',
  '%2F',
  '%5C',
  '%E2%82%AC',
  'ACME',
  ' acme ',
  'a?b',
  'a#b',
  'a'.repeat(512),
] as const;

function seededPathCorpus(count: number): string[] {
  const alphabet = '/%ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-';
  const paths: string[] = [];
  let state = 0x4e4f4f44;
  for (let pathIndex = 0; pathIndex < count; pathIndex += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const length = 1 + ((state >>> 0) % 96);
    let pathname = '';
    for (let charIndex = 0; charIndex < length; charIndex += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      pathname += alphabet[(state >>> 0) % alphabet.length] as string;
    }
    paths.push(pathname);
  }
  return paths;
}

function mutationCorpus(): string[] {
  const mutations = new Set<string>(seededPathCorpus(512));
  for (const pathname of CORPUS) {
    mutations.add(pathname);
    mutations.add(`${pathname}/`);
    mutations.add(`${pathname}/extra`);
    mutations.add(pathname.slice(1));
    mutations.add(`/${pathname}`);
    mutations.add(pathname.replace(/^\/v1(?=\/|$)/, '/v2'));
    mutations.add(pathname.replace(/^\/v1(?=\/|$)/, '/V1'));

    const segments = pathname.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      const removed = [...segments];
      removed.splice(index, 1);
      mutations.add(removed.join('/'));

      const duplicated = [...segments];
      duplicated.splice(index, 0, segments[index] as string);
      mutations.add(duplicated.join('/'));

      for (const hostile of HOSTILE_SEGMENTS) {
        const replaced = [...segments];
        replaced[index] = hostile;
        mutations.add(replaced.join('/'));
      }
    }
  }
  return [...mutations].sort();
}

type ParserObservation =
  | { readonly parser: string; readonly returned: unknown }
  | {
      readonly parser: string;
      readonly threw: { readonly name: string; readonly message: string };
    };

function observations(pathname: string): ParserObservation[] {
  const observed: ParserObservation[] = [];
  for (const { name: parser, parse } of PARSERS) {
    try {
      const result = parse(pathname);
      if (result !== undefined) observed.push({ parser, returned: result });
    } catch (error) {
      observed.push({
        parser,
        threw: {
          name: error instanceof Error ? error.name : typeof error,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  return observed;
}

/** Which parsers claim a URL, and what each returns. */
function claims(pathname: string): Record<string, unknown> {
  const matched: Record<string, unknown> = {};
  for (const { name, parse } of PARSERS) {
    const result = parse(pathname);
    if (result !== undefined) matched[name] = result;
  }
  return matched;
}

describe('service route surface lock', () => {
  it('resolves every corpus URL to the same parsers and refs', () => {
    const surface = Object.fromEntries(CORPUS.map((pathname) => [pathname, claims(pathname)]));
    expect(surface).toMatchSnapshot();
  });

  it('covers every exported path parser', () => {
    const claimed = new Set(CORPUS.flatMap((pathname) => Object.keys(claims(pathname))));
    const uncovered = PARSERS.filter((parser) => !claimed.has(parser.name)).map(
      (parser) => `${parser.source}:${parser.name}`,
    );
    expect(uncovered).toEqual([]);
  });

  it('locks the tenant action surface', () => {
    // parseTenantActionPath is the shared matcher the per-action helpers wrap; its accepted action
    // set is the tenant sub-route surface, so lock which actions resolve and which do not.
    const actions = [
      'status',
      'deploy/preflight',
      'access',
      'deployment-lock',
      'rollback',
      'inspect',
      'smoke',
      'logs',
      'metrics',
      'events',
      'intent-capture',
      'intents',
      'alerts',
      'auth/doctor',
      'auth/google-workload-identity',
      'auth/google-workload-identity/doctor',
    ] as const;
    const resolved = Object.fromEntries(
      actions.map((action) => [action, paths.parseTenantActionPath(`${TENANT}/${action}`, action)]),
    );
    expect(resolved).toMatchSnapshot();
  });

  it('rejects traversal and truncated tenant paths', () => {
    expect(paths.parseTenantDeployPath(`${TENANT}`)).toBeUndefined();
    expect(paths.parseTenantDeployPath(`/v1/orgs/${ORG}/apps/${APP}/deploy`)).toBeUndefined();
    expect(paths.parseAppItemPath(`/v1/orgs/${ORG}/apps/${APP}/envs`)).toBeUndefined();
    expect(paths.parseOrgPath('/v1/orgs')).toBeUndefined();
  });

  it('locks parser behavior over a deterministic hostile-path corpus', () => {
    const hostileCorpus = mutationCorpus();
    const serialized = JSON.stringify(
      hostileCorpus.map((pathname) => [pathname, observations(pathname)]),
    );

    expect(hostileCorpus).toHaveLength(6_468);
    expect(createHash('sha256').update(serialized).digest('hex')).toBe(
      '52e2b7aa8fccfb4a8bcc233f932062393e54cfc5c5fc8c7603b15c251b70bf26',
    );
  });

  it('rejects malformed public paths without throwing', () => {
    const thrown = mutationCorpus().flatMap((pathname) =>
      observations(pathname)
        .filter((observation) => 'threw' in observation)
        .map((observation) => ({ pathname, observation })),
    );

    expect(thrown).toEqual([]);
  });
});
