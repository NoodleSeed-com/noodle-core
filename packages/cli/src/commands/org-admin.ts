import type { ConfigLocation } from '../config.js';
/**
 * Org administration commands (moved from `session.ts` to keep both under the size gate): `orgs
 * list|create|rename|switch|current|inspect` and `members list|add|remove|set-role|invitations|revoke`.
 * Every operation rides the authenticated `/v1/orgs/...` control-plane routes; nothing here touches
 * storage directly. Every error path routes through `printCliFailure` so `--json` is honored
 * uniformly; the legacy `list`/`create`/`rename`/`members` success-path JSON shapes are unchanged
 * (flat `{ok, service, ...}`, no `data` wrapper) to avoid breaking existing consumers — only the new
 * `switch`/`current`/`inspect` verbs adopt the `printJsonOk` agent-native envelope.
 */
import { readConfig, writeConfig } from '../config.js';
import { resolveControlPlaneToken, ServiceRequestError, serviceJson } from '../control-plane.js';
import { ORANGE } from '../gradient.js';
import { readProjectLink } from '../project.js';
import { relativeTime, relativeUntil } from '../relative-time.js';
import { type Column, renderTable, type TableOptions } from '../table.js';
import { runOrgsDomains } from './org-domains.js';
import { runOrgsMcpSubdomain } from './org-mcp-subdomain.js';
import { parseMemberArgs, validateMemberActionArgs } from './org-member-args.js';
import { runOrgsOpenAIChallenge } from './org-openai-challenge.js';
import { EXIT, printJsonOk } from './output.js';
import {
  ACTIVE_GREEN,
  ARCHIVED_AMBER,
  authRequired,
  DIM_GRAY,
  dimText,
  stdoutTableOptions,
} from './resource-shared.js';
import {
  type CliFailure,
  commandFailure,
  parseCommandFlags,
  printCliFailure,
  usageError,
} from './shared.js';

export async function runOrgs(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const [action, ...actionRest] = rest;
  if (action === 'current') return runOrgsCurrent(actionRest, home);
  if (action === 'domains') return runOrgsDomains(actionRest, env, home);
  if (action === 'mcp-subdomain') return runOrgsMcpSubdomain(actionRest, env, home);
  if (action === 'openai-challenge') return runOrgsOpenAIChallenge(actionRest, env, home);
  const validated = validateOrgActionArgs(action, parseOrgArgs(actionRest));
  if (!validated.ok) {
    return printCliFailure('orgs', validated.failure, validated.json);
  }
  if (validated.action === 'switch') {
    return runOrgsSwitch(validated.slug, validated.args, env, home);
  }
  if (validated.action === 'inspect') {
    return runOrgsInspect(validated.slug, validated.args, env, home);
  }
  const args = validated.args;

  const { serviceUrl, token } = await resolveControlPlaneToken({
    serviceFlag: args.serviceFlag,
    authFlag: args.authFlag,
    env,
    home,
  });
  if (token === undefined) return printCliFailure('orgs', authRequired(), args.json);
  try {
    if (validated.action === 'list') {
      const body = await serviceJson<{
        ok: true;
        orgs: readonly OrgListRow[];
      }>(`${serviceUrl}/v1/orgs`, token);
      if (args.json) {
        printJsonOk({ service: serviceUrl, orgs: body.orgs });
        return EXIT.OK;
      }
      if (body.orgs.length > 0) console.log(renderOrgsTable(body.orgs, stdoutTableOptions()));
      else console.log('No organizations found.');
      return EXIT.OK;
    }
    if (validated.action === 'create') {
      const body = await serviceJson<{ ok: true; org: { slug: string; displayName?: string } }>(
        `${serviceUrl}/v1/orgs`,
        token,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            slug: validated.slug,
            ...(args.displayName ? { displayName: args.displayName } : {}),
          }),
        },
      );
      if (args.json) {
        printJsonOk({ service: serviceUrl, org: body.org });
        return EXIT.OK;
      }
      console.log(`created ${body.org.slug}`);
      return EXIT.OK;
    }
    if (validated.action === 'rename') {
      const body = await serviceJson<{ ok: true; org: { slug: string; displayName?: string } }>(
        `${serviceUrl}/v1/orgs/${encodeURIComponent(validated.slug)}`,
        token,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ displayName: args.name }),
        },
      );
      if (args.json) {
        printJsonOk({ service: serviceUrl, org: body.org });
        return EXIT.OK;
      }
      console.log(`renamed ${body.org.slug} to "${body.org.displayName ?? args.name}"`);
      return EXIT.OK;
    }
  } catch (error) {
    return printCliFailure('orgs', commandFailure(error, 'noodle orgs list'), args.json);
  }
  return printCliFailure(
    'orgs',
    usageError(
      'usage: noodle orgs list|create|rename|switch|current|inspect|domains|openai-challenge',
      'noodle orgs --help',
    ),
    args.json,
  );
}

// --- orgs switch ---------------------------------------------------------------

async function runOrgsSwitch(
  slug: string,
  args: OrgArgs,
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const { serviceUrl, token } = await resolveControlPlaneToken({
    serviceFlag: args.serviceFlag,
    authFlag: args.authFlag,
    env,
    home,
  });
  if (token === undefined) return printCliFailure('orgs', authRequired(), args.json);
  try {
    const body = await serviceJson<{
      ok: true;
      orgs: readonly { slug: string; displayName?: string }[];
    }>(`${serviceUrl}/v1/orgs`, token);
    if (!body.orgs.some((org) => org.slug === slug)) {
      return printCliFailure(
        'orgs',
        {
          code: 'not_a_member',
          message: `You are not a member of org "${slug}"`,
          cause: `The signed-in identity is not a member of org "${slug}".`,
          fix: 'Choose an org you belong to, or ask an owner to add you.',
          next: 'noodle orgs list',
          exitCode: EXIT.FAILURE,
        },
        args.json,
      );
    }
    const config = readConfig(home);
    const previous = config.defaultOrg;
    writeConfig({ ...config, defaultOrg: slug }, home);
    if (args.json) {
      printJsonOk({ org: slug, previous: previous ?? null });
      return EXIT.OK;
    }
    console.log(`Switched to ${slug}.`);
    return EXIT.OK;
  } catch (error) {
    return printCliFailure('orgs', commandFailure(error, 'noodle orgs list'), args.json);
  }
}

// --- orgs current --------------------------------------------------------------

type OrgTargetSource = 'link' | 'config';

function resolveCurrentOrg(
  home: ConfigLocation,
): { readonly org: string; readonly source: OrgTargetSource } | undefined {
  const project = readProjectLink();
  if (project !== undefined) return { org: project.org, source: 'link' };
  const config = readConfig(home);
  if (config.defaultOrg !== undefined) return { org: config.defaultOrg, source: 'config' };
  return undefined;
}

function runOrgsCurrent(rest: readonly string[], home: ConfigLocation): number {
  const json = rest.includes('--json');
  const resolved = resolveCurrentOrg(home);
  if (resolved === undefined) {
    return printCliFailure(
      'orgs',
      {
        code: 'target_required',
        message: 'No active org is set',
        cause: 'No org target was supplied or saved.',
        fix: 'Switch to an org you belong to.',
        next: 'noodle orgs switch <org>',
        exitCode: EXIT.USAGE,
      },
      json,
    );
  }
  if (json) {
    printJsonOk({ org: resolved.org, source: resolved.source });
    return EXIT.OK;
  }
  console.log(`${resolved.org} (from ${resolved.source})`);
  return EXIT.OK;
}

// --- orgs inspect ----------------------------------------------------------------

async function runOrgsInspect(
  slug: string,
  args: OrgArgs,
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const { serviceUrl, token } = await resolveControlPlaneToken({
    serviceFlag: args.serviceFlag,
    authFlag: args.authFlag,
    env,
    home,
  });
  if (token === undefined) return printCliFailure('orgs', authRequired(), args.json);
  try {
    const body = await serviceJson<{
      ok: true;
      data: { slug: string; displayName?: string; createdAt: string };
    }>(`${serviceUrl}/v1/orgs/${encodeURIComponent(slug)}`, token);
    if (args.json) {
      printJsonOk(body.data);
      return EXIT.OK;
    }
    console.log(`slug:        ${body.data.slug}`);
    console.log(`displayName: ${body.data.displayName ?? '—'}`);
    console.log(`created:     ${body.data.createdAt}`);
    return EXIT.OK;
  } catch (error) {
    // The service 404s an org the caller cannot see identically to an unknown slug (never leak
    // existence across tenants) — collapse both into one `not_found` failure, exit 1.
    if (error instanceof ServiceRequestError && (error.status === 404 || error.status === 403)) {
      return printCliFailure(
        'orgs',
        {
          code: 'not_found',
          message: `org "${slug}" was not found`,
          cause: `${slug} was not found, or you do not have access to it.`,
          fix: 'Check the org slug, or list the orgs you belong to.',
          next: 'noodle orgs list',
          exitCode: EXIT.FAILURE,
        },
        args.json,
      );
    }
    return printCliFailure('orgs', commandFailure(error, 'noodle orgs list'), args.json);
  }
}

// --- members ---------------------------------------------------------------------

export async function runMembers(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const [action, ...tail] = rest;
  const validated = validateMemberActionArgs(action, parseMemberArgs(tail));
  if (!validated.ok) {
    return printCliFailure('members', validated.failure, validated.json);
  }
  const args = validated.args;
  const { serviceUrl, token } = await resolveControlPlaneToken({
    serviceFlag: args.serviceFlag,
    authFlag: args.authFlag,
    env,
    home,
  });
  if (token === undefined) return printCliFailure('members', authRequired(), args.json);
  try {
    const base = `${serviceUrl}/v1/orgs/${encodeURIComponent(validated.org)}/members`;
    const invitationsBase = `${serviceUrl}/v1/orgs/${encodeURIComponent(validated.org)}/invitations`;
    if (validated.action === 'list') {
      const body = await serviceJson<{
        ok: true;
        members: readonly MemberRow[];
      }>(base, token);
      if (args.json) {
        printJsonOk({ service: serviceUrl, org: validated.org, members: body.members });
        return EXIT.OK;
      }
      if (body.members.length > 0) {
        console.log(renderMembersTable(body.members, stdoutTableOptions()));
        console.log(
          dimText(
            `Invite: noodle members add --org ${validated.org} --subject <subject> --email <email>`,
            process.stdout,
          ),
        );
      } else {
        console.log(`No members in ${validated.org}.`);
      }
      return EXIT.OK;
    }
    if (validated.action === 'add') {
      await serviceJson(base, token, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subject: validated.subject,
          email: validated.email,
          ...(args.role ? { role: args.role } : {}),
        }),
      });
      if (args.json) {
        printJsonOk({ service: serviceUrl, org: validated.org, email: validated.email });
        return EXIT.OK;
      }
      console.log(`added ${validated.email}`);
      return EXIT.OK;
    }
    if (validated.action === 'remove') {
      await serviceJson(`${base}/${encodeURIComponent(validated.subject)}`, token, {
        method: 'DELETE',
      });
      if (args.json) {
        printJsonOk({
          service: serviceUrl,
          org: validated.org,
          subject: validated.subject,
          removed: true,
        });
        return EXIT.OK;
      }
      console.log(`removed ${validated.subject}`);
      return EXIT.OK;
    }
    if (validated.action === 'set-role') {
      const body = await serviceJson<{
        ok: true;
        member: { subject: string; email: string; role: string };
      }>(`${base}/${encodeURIComponent(validated.subject)}`, token, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: validated.role }),
      });
      if (args.json) {
        printJsonOk({ service: serviceUrl, org: validated.org, member: body.member });
        return EXIT.OK;
      }
      console.log(`set ${body.member.subject} to ${body.member.role}`);
      return EXIT.OK;
    }
    if (validated.action === 'invitations') {
      const body = await serviceJson<{
        ok: true;
        invitations: readonly InvitationRow[];
      }>(args.all ? `${invitationsBase}?all=true` : invitationsBase, token);
      if (args.json) {
        printJsonOk({
          service: serviceUrl,
          org: validated.org,
          invitations: body.invitations,
        });
        return EXIT.OK;
      }
      if (body.invitations.length > 0) {
        console.log(renderInvitationsTable(body.invitations, stdoutTableOptions()));
      } else {
        console.log('No invitations found.');
      }
      return EXIT.OK;
    }
    if (validated.action === 'revoke') {
      const body = await serviceJson<{ ok: true; revoked: number }>(invitationsBase, token, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: validated.email }),
      });
      if (args.json) {
        printJsonOk({
          service: serviceUrl,
          org: validated.org,
          email: validated.email,
          revoked: body.revoked,
        });
        return EXIT.OK;
      }
      console.log(`revoked ${body.revoked} invitation(s) for ${validated.email}`);
      return EXIT.OK;
    }
  } catch (error) {
    return printCliFailure('members', commandFailure(error, 'noodle members list'), args.json);
  }
  return printCliFailure(
    'members',
    usageError(
      'usage: noodle members list|add|remove|set-role|invitations|revoke',
      'noodle members --help',
    ),
    args.json,
  );
}

// --- table rendering ---------------------------------------------------------------
//
// Branded list views (founder-approved design, 2026-07-06). The wire rows are passthroughs of the
// service records, so `--json` output stays byte-identical; only the human tables changed shape.

/** One `GET /v1/orgs` row (a service `OrgRecord` passthrough; `createdAt` optional for old services). */
export interface OrgListRow {
  readonly slug: string;
  readonly displayName?: string;
  readonly createdAt?: string;
}

/** One `GET /v1/orgs/{org}/members` row (a service `OrgMemberRecord` passthrough). */
export interface MemberRow {
  readonly subject: string;
  readonly email: string;
  readonly role: string;
  readonly createdAt?: string;
}

/** One `GET /v1/orgs/{org}/invitations` row (the service's token-free public invitation). */
export interface InvitationRow {
  readonly email: string;
  readonly role: string;
  readonly status: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

// The wire carries no per-caller role for `orgs list`, so the approved ORG/ROLE/JOINED design
// adapts to the fields the route actually returns: ORG / NAME / CREATED.
const ORGS_COLUMNS: readonly Column<OrgListRow>[] = [
  { header: 'ORG', get: (o) => o.slug },
  {
    header: 'NAME',
    get: (o) => o.displayName ?? '—',
    color: (o) => (o.displayName === undefined ? DIM_GRAY : undefined),
  },
  {
    header: 'CREATED',
    get: (o) => (o.createdAt !== undefined ? relativeTime(o.createdAt) : '—'),
    align: 'right',
    color: () => DIM_GRAY,
  },
];

const MEMBERS_COLUMNS: readonly Column<MemberRow>[] = [
  { header: 'MEMBER', get: (m) => m.subject },
  { header: 'EMAIL', get: (m) => m.email, color: () => DIM_GRAY },
  {
    header: 'ROLE',
    get: (m) => m.role,
    color: (m) => (m.role === 'owner' ? ORANGE : m.role === 'invited' ? ARCHIVED_AMBER : undefined),
  },
  {
    header: 'JOINED',
    get: (m) => (m.createdAt !== undefined ? relativeTime(m.createdAt) : '—'),
    align: 'right',
    color: () => DIM_GRAY,
  },
];

// EXPIRES folds the invitation status in: pending shows the time remaining, accepted/expired show
// the terminal state (green/amber) — so `--all` stays readable without a fifth column.
const INVITATIONS_COLUMNS: readonly Column<InvitationRow>[] = [
  { header: 'EMAIL', get: (i) => i.email },
  {
    header: 'ROLE',
    get: (i) => i.role,
    color: (i) => (i.role === 'owner' ? ORANGE : undefined),
  },
  {
    header: 'INVITED',
    get: (i) => relativeTime(i.createdAt),
    align: 'right',
    color: () => DIM_GRAY,
  },
  {
    header: 'EXPIRES',
    get: (i) => (i.status === 'pending' ? relativeUntil(i.expiresAt) : i.status),
    align: 'right',
    color: (i) =>
      i.status === 'accepted' ? ACTIVE_GREEN : i.status === 'expired' ? ARCHIVED_AMBER : undefined,
  },
];

/** Render the `orgs list` table. Exported so tests can call it directly. */
export function renderOrgsTable(orgs: readonly OrgListRow[], opts: TableOptions): string {
  return renderTable(ORGS_COLUMNS, orgs, opts);
}

/** Render the `members list` table. Exported so tests can call it directly. */
export function renderMembersTable(members: readonly MemberRow[], opts: TableOptions): string {
  return renderTable(MEMBERS_COLUMNS, members, opts);
}

/** Render the `members invitations` table. Exported so tests can call it directly. */
export function renderInvitationsTable(
  invitations: readonly InvitationRow[],
  opts: TableOptions,
): string {
  return renderTable(INVITATIONS_COLUMNS, invitations, opts);
}

// --- shared failure builders -----------------------------------------------------

/**
 * Preserves the pre-existing exit-1 behavior for any org/members service call failure (a 403 from a
 * non-owner action is a domain permission failure here, not a "please sign in" auth failure — unlike
 * `serviceFailure()`, which would map it to exit 3). Only the explicit `authRequired()` "no token"
 * path uses exit 3.
 */

// --- arg parsing -------------------------------------------------------------------

interface OrgArgs {
  readonly serviceFlag?: string;
  readonly authFlag?: string;
  readonly displayName?: string;
  readonly name?: string;
  readonly json: boolean;
  readonly positional: readonly string[];
  readonly parseError?: string;
}

type ValidatedOrgAction =
  | { readonly ok: true; readonly action: 'list'; readonly args: OrgArgs }
  | {
      readonly ok: true;
      readonly action: 'create' | 'rename' | 'switch' | 'inspect';
      readonly args: OrgArgs;
      readonly slug: string;
    }
  | { readonly ok: false; readonly failure: CliFailure; readonly json: boolean };

function validateOrgActionArgs(action: string | undefined, args: OrgArgs): ValidatedOrgAction {
  if (args.parseError !== undefined) {
    return {
      ok: false,
      failure: usageError(args.parseError, 'noodle orgs --help'),
      json: args.json,
    };
  }
  if (action === 'list') {
    return args.positional.length === 0
      ? { ok: true, action, args }
      : {
          ok: false,
          failure: usageError('orgs list does not accept a slug', 'noodle orgs list'),
          json: args.json,
        };
  }
  const [slug] = args.positional;
  if (action === 'create' && slug !== undefined && args.positional.length === 1) {
    return { ok: true, action, args, slug };
  }
  if (
    action === 'rename' &&
    slug !== undefined &&
    args.positional.length === 1 &&
    args.name !== undefined
  ) {
    return { ok: true, action, args, slug };
  }
  if (
    (action === 'switch' || action === 'inspect') &&
    slug !== undefined &&
    args.positional.length === 1
  ) {
    return { ok: true, action, args, slug };
  }
  const failure =
    action === 'create'
      ? usageError('orgs create requires a slug', 'noodle orgs create <slug>')
      : action === 'rename'
        ? usageError(
            'orgs rename requires a slug and --name',
            'noodle orgs rename <slug> --name <displayName>',
          )
        : action === 'switch'
          ? usageError('orgs switch requires an org slug', 'noodle orgs list')
          : action === 'inspect'
            ? usageError('orgs inspect requires an org slug', 'noodle orgs list')
            : usageError(
                'usage: noodle orgs list|create|rename|switch|current|inspect|domains|openai-challenge',
                'noodle orgs --help',
              );
  return { ok: false, failure, json: args.json };
}

function parseOrgArgs(rest: readonly string[]): OrgArgs {
  return parseCommandFlags(rest, {
    values: {
      '--service': 'serviceFlag',
      '--auth-token': 'authFlag',
      '--display-name': 'displayName',
      '--name': 'name',
    },
    booleans: { '--json': 'json' },
  });
}
