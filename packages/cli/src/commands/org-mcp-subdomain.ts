import { randomUUID } from 'node:crypto';
import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, serviceJson } from '../control-plane.js';
import { confirm as confirmPrompt, isInteractive as detectInteractive } from '../prompts.js';
import { EXIT, printJsonOk } from './output.js';
import { authRequired, resolveOrgTarget } from './resource-shared.js';
import { parseCommandFlags, printCliFailure, serviceFailure, usageError } from './shared.js';

const URL_BREAKAGE_WARNING =
  'Existing MCP server URLs stop working immediately when the organization MCP subdomain changes.';

interface McpSubdomainSetting {
  readonly orgSlug: string;
  readonly mcpSubdomain: string;
  readonly mcpServerHost: string | null;
  readonly changeAllowedAt: string | null;
}

interface McpSubdomainMutation extends McpSubdomainSetting {
  readonly previousMcpSubdomain: string;
  readonly previousMcpServerHost: string | null;
  readonly changed: boolean;
  readonly replayed: boolean;
  readonly changedAt: string | null;
  readonly oldUrlsInvalidated: boolean;
  readonly reauthorizationRequired: boolean;
}

const DEFAULT_PROMPTS = {
  isInteractive: detectInteractive,
  confirm: confirmPrompt,
};

export async function runOrgsMcpSubdomain(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
  prompts: typeof DEFAULT_PROMPTS = DEFAULT_PROMPTS,
): Promise<number> {
  const args = parseMcpSubdomainArgs(rest);
  const invalid: readonly [message: string, next: string] | undefined =
    args.parseError !== undefined
      ? [args.parseError, 'noodle orgs mcp-subdomain --help']
      : args.action !== 'get' && args.action !== 'set'
        ? ['orgs mcp-subdomain requires get or set', 'noodle orgs mcp-subdomain get']
        : args.action === 'get' && (args.requested !== undefined || args.yes)
          ? ['orgs mcp-subdomain get takes no value or --yes flag', 'noodle orgs mcp-subdomain get']
          : args.action === 'set' && args.requested === undefined
            ? [
                'orgs mcp-subdomain set requires a new subdomain',
                'noodle orgs mcp-subdomain set <new-subdomain>',
              ]
            : undefined;
  if (invalid !== undefined) {
    return printCliFailure('orgs mcp-subdomain', usageError(...invalid), args.json);
  }

  const target = resolveOrgTarget(args.org, home);
  if (!target.ok) return printCliFailure('orgs mcp-subdomain', target.error, args.json);
  const org = target.org;

  if (args.action === 'set' && !args.yes && (args.json || !prompts.isInteractive())) {
    return printCliFailure(
      'orgs mcp-subdomain',
      {
        code: 'confirmation_required',
        message: 'Changing the organization MCP subdomain requires confirmation',
        cause: `${URL_BREAKAGE_WARNING} The old host will not redirect and can never be reused.`,
        fix: 'Update every MCP client after the change, then reconnect and reauthorize.',
        next: `noodle orgs mcp-subdomain set ${args.requested} --org ${org} --yes`,
        exitCode: EXIT.USAGE,
      },
      args.json,
    );
  }

  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.serviceFlag,
    authFlag: args.authFlag,
    env,
    home,
  });
  if (resolved.token === undefined) {
    return printCliFailure('orgs mcp-subdomain', authRequired(), args.json);
  }
  const endpoint = `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(org)}/mcp-subdomain`;

  try {
    const settingBody = await serviceJson<{ ok: true; data: McpSubdomainSetting }>(
      endpoint,
      resolved.token,
    );
    if (args.action === 'get') {
      return printSetting(settingBody.data, args.json);
    }

    const requested = args.requested as string;
    if (!args.json) printBreakageWarning(settingBody.data, requested);
    if (!args.yes) {
      const confirmed = await prompts.confirm('Change the organization MCP subdomain?', {
        initial: false,
      });
      if (!confirmed) {
        console.error('orgs mcp-subdomain: cancelled');
        return EXIT.USAGE;
      }
    }

    const mutationBody = await serviceJson<{ ok: true; data: McpSubdomainMutation }>(
      endpoint,
      resolved.token,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': randomUUID(),
        },
        body: JSON.stringify({
          mcpSubdomain: requested,
          acknowledgeOldUrlsStopWorking: true,
        }),
      },
    );
    return printMutation(mutationBody.data, args.json);
  } catch (error) {
    return printCliFailure(
      'orgs mcp-subdomain',
      serviceFailure('orgs mcp-subdomain', error, `noodle orgs mcp-subdomain get --org ${org}`),
      args.json,
    );
  }
}

function printSetting(setting: McpSubdomainSetting, json: boolean): number {
  if (json) printJsonOk(setting);
  else {
    console.log(`organization:      ${setting.orgSlug}`);
    console.log(`MCP subdomain:     ${setting.mcpSubdomain}`);
    console.log(`MCP server host:   ${setting.mcpServerHost ?? 'not configured'}`);
    console.log(`next change after: ${setting.changeAllowedAt ?? 'now'}`);
  }
  return EXIT.OK;
}

function printMutation(mutation: McpSubdomainMutation, json: boolean): number {
  const data = {
    ...mutation,
    reconnectRequired: mutation.reauthorizationRequired,
  };
  if (json) {
    printJsonOk(data, mutation.changed ? [URL_BREAKAGE_WARNING] : undefined);
    return EXIT.OK;
  }
  if (!mutation.changed) {
    console.log(`MCP subdomain is already ${mutation.mcpSubdomain}.`);
    return EXIT.OK;
  }
  console.log(`MCP subdomain changed to ${mutation.mcpSubdomain}.`);
  console.log(`MCP server host: ${mutation.mcpServerHost ?? 'not configured'}`);
  console.log('Update every MCP client to the new URL, then reconnect and reauthorize.');
  console.log(`Another change is available after ${mutation.changeAllowedAt}.`);
  return EXIT.OK;
}

function printBreakageWarning(setting: McpSubdomainSetting, requested: string): void {
  console.log(`Current MCP server host: ${setting.mcpServerHost ?? 'not configured'}`);
  console.log(
    `New MCP server host:     ${proposedMcpServerHost(setting, requested) ?? 'not configured'}`,
  );
  console.log(`Warning: ${URL_BREAKAGE_WARNING}`);
  console.log('The old host will not redirect and can never be reused.');
  console.log('Update every MCP client to the new URL, then reconnect and reauthorize.');
  console.log('After a successful change, another change is unavailable for 30 days.');
}

function proposedMcpServerHost(setting: McpSubdomainSetting, label: string): string | null {
  if (setting.mcpServerHost === null) return null;
  return `${label}${setting.mcpServerHost.slice(setting.mcpSubdomain.length)}`;
}

function parseMcpSubdomainArgs(rest: readonly string[]) {
  const { positional, parseError, ...flags } = parseCommandFlags(rest, {
    values: { '--org': 'org', '--service': 'serviceFlag', '--auth-token': 'authFlag' },
    booleans: { '--json': 'json', '--yes': 'yes' },
  });
  const error =
    parseError ??
    (positional.length > 2 ? 'orgs mcp-subdomain received too many values' : undefined);
  return {
    ...(positional[0] !== undefined ? { action: positional[0] } : {}),
    ...(positional[1] !== undefined ? { requested: positional[1] } : {}),
    ...flags,
    ...(error !== undefined ? { parseError: error } : {}),
  };
}
