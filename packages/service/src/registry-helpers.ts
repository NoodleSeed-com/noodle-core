import type { CapabilityName } from '@noodle-borg/capabilities';
import type { SecretBinding } from '@noodle-borg/connector-defs';
import type { OrgMembershipSource } from '@noodle-borg/module';
import type { AccessMode } from '@noodle-borg/transport-http';
import type { DeployError } from './registry.js';
import type { DeployRecord } from './store.js';

/**
 * Provenance of an env's current active deployment — the inherit source for GHD-3 run-deploy
 * access-mode resolution (ADR 0132 Decision 4). The owner subject lets an inherited `owner-only` run deploy
 * preserve the PREVIOUS human owner instead of rebinding the app to the automation subject.
 */
export type ActiveDeployProvenance =
  | {
      readonly accessMode: AccessMode | undefined;
      readonly orgMembershipSources: readonly OrgMembershipSource[] | undefined;
      readonly ownerSubject: string | undefined;
    }
  | undefined;

/** Resolve the durable owner binding while keeping legacy creator-only records readable. */
export function deploymentOwnerSubject(
  record: Pick<DeployRecord, 'ownerSubject' | 'createdBySubject'>,
): string | undefined {
  return record.ownerSubject ?? record.createdBySubject;
}

export function missingCapabilityErrors(
  required: readonly CapabilityName[],
  available: readonly CapabilityName[],
): readonly DeployError[] {
  const enabled = new Set(available);
  return required
    .filter((name) => !enabled.has(name))
    .map((name) => ({
      code: 'missing_capability',
      path: `requires.${name}`,
      message: `This server requires ${name}, but the target service does not have ${capabilityLabel(name)} enabled. Enable the ${name} capability or deploy to a different target.`,
    }));
}

export function missingSecretErrors(
  bindings: readonly SecretBinding[],
  secrets: Readonly<Record<string, string>>,
): DeployError[] {
  const seen = new Set<string>();
  const errors: DeployError[] = [];
  for (const binding of bindings) {
    if (binding.secretRef === undefined) continue;
    if (secrets[binding.secretRef] === undefined && !seen.has(binding.secretRef)) {
      seen.add(binding.secretRef);
      errors.push({
        code: 'missing_secret',
        path: `secrets.${binding.secretRef}`,
        message: `no managed value found for required secret "${binding.secretRef}"`,
      });
    }
  }
  return errors;
}

export function missingVariableErrors(
  bindings: readonly string[],
  variables: Readonly<Record<string, string>>,
): DeployError[] {
  const seen = new Set<string>();
  const errors: DeployError[] = [];
  for (const name of bindings) {
    if (variables[name] === undefined && !seen.has(name)) {
      seen.add(name);
      errors.push({
        code: 'missing_variable',
        path: `variables.${name}`,
        message: `no managed value found for required variable "${name}"`,
      });
    }
  }
  return errors;
}

export function deployAccessRequiresActor(accessMode: AccessMode): boolean {
  return accessMode !== 'public' && accessMode !== 'mixed';
}

/** An identity access mode was requested without an authenticated deployer. */
export function deployerRequiredError(accessMode: AccessMode): {
  readonly ok: false;
  readonly errors: readonly DeployError[];
} {
  return {
    ok: false,
    errors: [
      {
        code: 'identity_access_requires_identity',
        path: 'accessMode',
        message: `${accessMode} deployments require an authenticated deployer`,
      },
    ],
  };
}

/** An empty narrowing would deploy an endpoint nobody can call, so it is rejected rather than stored. */
export function emptyMembershipSourcesError(): {
  readonly ok: false;
  readonly errors: readonly DeployError[];
} {
  return {
    ok: false,
    errors: [
      {
        code: 'membership_sources_empty',
        path: 'orgMembershipSources',
        message: 'orgMembershipSources must name at least one source',
      },
    ],
  };
}

/** Narrowing only means something for `org-members`; anywhere else it would silently do nothing. */
export function membershipSourcesRequireOrgMembersError(): {
  readonly ok: false;
  readonly errors: readonly DeployError[];
} {
  return {
    ok: false,
    errors: [
      {
        code: 'membership_sources_requires_org_members',
        path: 'orgMembershipSources',
        message: 'orgMembershipSources requires the org-members access mode',
      },
    ],
  };
}

/** `customers` needs a tenant IdP config the manifest did not declare. */
export function serverAuthRequiredError(): {
  readonly ok: false;
  readonly errors: readonly DeployError[];
} {
  return {
    ok: false,
    errors: [
      {
        code: 'server_auth_required',
        path: 'server.auth',
        message: 'customers access mode requires server.auth',
      },
    ],
  };
}

export function missingSecretNames(errors: readonly DeployError[]): string[] {
  const names = new Set<string>();
  for (const error of errors) {
    if (error.code === 'missing_secret' && error.path.startsWith('secrets.')) {
      names.add(error.path.slice('secrets.'.length));
    }
  }
  return [...names].sort();
}

function capabilityLabel(name: CapabilityName): string {
  return name[0] === undefined ? name : `${name[0].toUpperCase()}${name.slice(1)}`;
}
