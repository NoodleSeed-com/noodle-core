import { createHash } from 'node:crypto';
import {
  builtInDefinition,
  type PrivateDefinitionSelector,
  type SolutionDefinitionSnapshot,
} from '../business-information/portable.js';

interface InstallationDefinitionSelector {
  readonly kind: 'managed' | 'private';
  readonly profileId?: 'travel' | 'ecommerce' | 'restaurant';
  readonly publisherOrg?: string;
  readonly app?: string;
  readonly environment?: string;
  readonly deploymentId?: string;
}

export function stableInstallationId(org: string, app: string, env: string): string {
  return `ins-${createHash('sha256').update(`${org}\0${app}\0${env}`).digest('hex').slice(0, 24)}`;
}

export async function resolveInstallDefinition(
  selector: InstallationDefinitionSelector,
  installingOrg: string,
  resolvePrivateDefinition:
    | ((selector: PrivateDefinitionSelector) => Promise<SolutionDefinitionSnapshot | undefined>)
    | undefined,
): Promise<SolutionDefinitionSnapshot | undefined> {
  if (selector.kind === 'managed') {
    return builtInDefinition(selector.profileId as 'travel' | 'ecommerce' | 'restaurant');
  }
  if (
    selector.publisherOrg !== installingOrg ||
    selector.publisherOrg === undefined ||
    selector.app === undefined ||
    selector.environment === undefined ||
    selector.deploymentId === undefined
  ) {
    return undefined;
  }
  return resolvePrivateDefinition?.({
    publisherOrg: selector.publisherOrg,
    app: selector.app,
    environment: selector.environment,
    deploymentId: selector.deploymentId,
  });
}
