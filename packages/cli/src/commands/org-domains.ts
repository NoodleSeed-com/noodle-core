import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, serviceJson } from '../control-plane.js';
import { EXIT, printJsonOk } from './output.js';
import { authRequired } from './resource-shared.js';
import { commandFailure, parseCommandFlags, printCliFailure, usageError } from './shared.js';

/**
 * `noodle orgs domains list|add|remove` — org domains admit anyone who signs in with a matching verified
 * address, so adding a domain is the grant and removing it is the revocation (ADR 0181).
 */

interface OrgDomainsBody {
  readonly orgSlug: string;
  readonly domains: readonly { readonly domain: string; readonly createdAt: string }[];
}

export async function runOrgsDomains(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const args = parseDomainsArgs(rest);
  const [action, slug, ...domains] = args.positional;
  const json = args.json;
  if (args.parseError !== undefined) {
    return printCliFailure('orgs', usageError(args.parseError, 'noodle orgs domains --help'), json);
  }
  if (action !== 'list' && action !== 'add' && action !== 'remove') {
    return printCliFailure(
      'orgs',
      usageError('orgs domains requires list, add, or remove', 'noodle orgs domains list <org>'),
      json,
    );
  }
  if (slug === undefined) {
    return printCliFailure(
      'orgs',
      usageError('orgs domains requires an org slug', `noodle orgs domains ${action} <org>`),
      json,
    );
  }
  if (action === 'list' && domains.length > 0) {
    return printCliFailure(
      'orgs',
      usageError('orgs domains list takes no domains', 'noodle orgs domains list <org>'),
      json,
    );
  }
  if (action !== 'list' && domains.length === 0) {
    return printCliFailure(
      'orgs',
      usageError(
        `orgs domains ${action} requires at least one domain`,
        `noodle orgs domains ${action} <org> <domain...>`,
      ),
      json,
    );
  }
  if (action === 'remove' && domains.length !== 1) {
    return printCliFailure(
      'orgs',
      usageError(
        'orgs domains remove takes exactly one domain',
        'noodle orgs domains remove <org> <domain>',
      ),
      json,
    );
  }

  const { serviceUrl, token } = await resolveControlPlaneToken({
    serviceFlag: args.serviceFlag,
    authFlag: args.authFlag,
    env,
    home,
  });
  if (token === undefined) return printCliFailure('orgs', authRequired(), json);
  const base = `${serviceUrl}/v1/orgs/${encodeURIComponent(slug)}/domains`;
  try {
    if (action === 'remove') {
      const domain = domains[0] as string;
      await serviceJson<{ ok: true; removed: boolean }>(
        `${base}/${encodeURIComponent(domain)}`,
        token,
        { method: 'DELETE' },
      );
      if (json) {
        printJsonOk({ org: slug, domain, removed: true });
        return EXIT.OK;
      }
      console.log(`Removed ${domain} from ${slug}.`);
      return EXIT.OK;
    }
    const body =
      action === 'add'
        ? await serviceJson<{ ok: true; data: OrgDomainsBody }>(base, token, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ domains }),
          })
        : await serviceJson<{ ok: true; data: OrgDomainsBody }>(base, token);
    if (json) {
      printJsonOk(body.data);
      return EXIT.OK;
    }
    printOrgDomains(body.data);
    return EXIT.OK;
  } catch (error) {
    return printCliFailure('orgs', commandFailure(error, 'noodle orgs domains list <org>'), json);
  }
}

function printOrgDomains(data: OrgDomainsBody): void {
  console.log(`org:     ${data.orgSlug}`);
  if (data.domains.length === 0) {
    console.log('domains: none');
    console.log('Add one with: noodle orgs domains add <org> <domain>');
    return;
  }
  console.log('domains:');
  for (const entry of data.domains) console.log(`  ${entry.domain}`);
  console.log('Anyone signing in with an address at these domains can use this org’s');
  console.log('org-members deployments.');
}

function parseDomainsArgs(rest: readonly string[]): {
  readonly serviceFlag?: string;
  readonly authFlag?: string;
  readonly json: boolean;
  readonly positional: readonly string[];
  readonly parseError?: string;
} {
  return parseCommandFlags(rest, {
    values: { '--service': 'serviceFlag', '--auth-token': 'authFlag' },
    booleans: { '--json': 'json' },
  });
}
