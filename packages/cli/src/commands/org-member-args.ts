import { EXIT } from './output.js';
import { type CliFailure, parseCommandFlags, usageError } from './shared.js';

export interface MemberArgs {
  readonly serviceFlag?: string;
  readonly authFlag?: string;
  readonly org?: string;
  readonly subject?: string;
  readonly email?: string;
  readonly role?: 'owner' | 'developer';
  readonly json: boolean;
  readonly all: boolean;
  readonly parseError?: string;
}

export type ValidatedMemberAction =
  | {
      readonly ok: true;
      readonly action: 'list' | 'invitations';
      readonly args: MemberArgs;
      readonly org: string;
    }
  | {
      readonly ok: true;
      readonly action: 'add';
      readonly args: MemberArgs;
      readonly org: string;
      readonly subject: string;
      readonly email: string;
    }
  | {
      readonly ok: true;
      readonly action: 'remove';
      readonly args: MemberArgs;
      readonly org: string;
      readonly subject: string;
    }
  | {
      readonly ok: true;
      readonly action: 'set-role';
      readonly args: MemberArgs;
      readonly org: string;
      readonly subject: string;
      readonly role: 'owner' | 'developer';
    }
  | {
      readonly ok: true;
      readonly action: 'revoke';
      readonly args: MemberArgs;
      readonly org: string;
      readonly email: string;
    }
  | { readonly ok: false; readonly failure: CliFailure; readonly json: boolean };

export function validateMemberActionArgs(
  action: string | undefined,
  args: MemberArgs,
): ValidatedMemberAction {
  if (args.parseError !== undefined) {
    return {
      ok: false,
      failure: usageError(args.parseError, 'noodle members --help'),
      json: args.json,
    };
  }
  if (args.org === undefined) {
    return {
      ok: false,
      failure: {
        code: 'target_required',
        message: 'members requires --org',
        cause: 'No org was supplied for the members command.',
        fix: 'Pass --org <slug>.',
        next: 'noodle orgs list',
        exitCode: EXIT.USAGE,
      },
      json: args.json,
    };
  }
  if (action === 'list' || action === 'invitations') {
    return { ok: true, action, args, org: args.org };
  }
  if (action === 'add' && args.subject !== undefined && args.email !== undefined) {
    return {
      ok: true,
      action,
      args,
      org: args.org,
      subject: args.subject,
      email: args.email,
    };
  }
  if (action === 'remove' && args.subject !== undefined) {
    return { ok: true, action, args, org: args.org, subject: args.subject };
  }
  if (action === 'set-role' && args.subject !== undefined && args.role !== undefined) {
    return {
      ok: true,
      action,
      args,
      org: args.org,
      subject: args.subject,
      role: args.role,
    };
  }
  if (action === 'revoke' && args.email !== undefined) {
    return { ok: true, action, args, org: args.org, email: args.email };
  }
  const failure =
    action === 'add'
      ? usageError('members add requires --subject and --email', 'noodle members --help')
      : action === 'remove'
        ? usageError('members remove requires --subject', 'noodle members --help')
        : action === 'set-role'
          ? usageError('members set-role requires --subject and --role', 'noodle members --help')
          : action === 'revoke'
            ? usageError('members revoke requires --email', 'noodle members --help')
            : usageError(
                'usage: noodle members list|add|remove|set-role|invitations|revoke',
                'noodle members --help',
              );
  return { ok: false, failure, json: args.json };
}

export function parseMemberArgs(rest: readonly string[]): MemberArgs {
  const { role, positional, parseError, ...args } = parseCommandFlags(rest, {
    values: {
      '--service': 'serviceFlag',
      '--auth-token': 'authFlag',
      '--org': 'org',
      '--subject': 'subject',
      '--email': 'email',
      '--role': 'role',
    },
    booleans: { '--json': 'json', '--all': 'all' },
  });
  const invalidRole = role !== undefined && role !== 'owner' && role !== 'developer';
  return {
    ...args,
    ...(role === 'owner' || role === 'developer' ? { role } : {}),
    ...(parseError !== undefined
      ? { parseError }
      : invalidRole
        ? { parseError: '--role must be owner or developer' }
        : positional[0] !== undefined
          ? { parseError: `unexpected positional argument: ${positional[0]}` }
          : {}),
  };
}
