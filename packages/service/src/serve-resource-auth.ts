import { resolveMcpSubdomainTenant } from '@noodle-borg/control-plane/portable';
import {
  normalizePublicBaseDomain,
  parseCanonicalPublicMcpUrl,
  parseLegacyTenantMcpPath,
} from '@noodle-borg/module';
import type { SecretBox } from '@noodle-borg/runtime';
import { resolveTenantBridgeAuthVariables } from './managed-config-expressions.js';
import type { ServerRegistry } from './registry.js';
import type { ServeServiceOptions } from './serve-options.js';
import {
  type ControlPlaneStore,
  resolveConfigScope,
  type SecretEnvelope,
  type TenantBridgeAuthConfig,
  type TenantRef,
} from './store.js';

interface TenantResourceRef extends TenantRef {
  readonly serverVersion?: string;
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

export function assertLocalDevtoolsServiceBoundary(
  host: string,
  options: ServeServiceOptions,
): void {
  if (options.localDevtoolsDirectFirebaseAuth === true && !isLoopbackHost(host)) {
    throw new Error('local Devtools Firebase verification requires a loopback service bind');
  }
  if (options.localDevtoolsDirectMicrosoftAuth === true && !isLoopbackHost(host)) {
    throw new Error('local Devtools Microsoft verification requires a loopback service bind');
  }
  if (options.localDevtoolsDelegatedExchange !== undefined && !isLoopbackHost(host)) {
    throw new Error('local Devtools delegated exchange requires an exclusive loopback bind');
  }
  if (options.localDevtoolsDelegatedExchange !== undefined && options.oauth !== undefined) {
    throw new Error('local Devtools and hosted OAuth signing authorities cannot coexist');
  }
}

export async function sealCustomerCredential(
  secretBox: SecretBox | undefined,
  credential: string,
): Promise<SecretEnvelope> {
  if (secretBox !== undefined) {
    return { enc: 'aes-256-gcm', sealed: await secretBox.seal(credential) };
  }
  return { enc: 'none', values: { token: credential } };
}

export async function openCustomerCredential(
  secretBox: SecretBox | undefined,
  envelope: SecretEnvelope,
): Promise<string> {
  if (envelope.enc === 'none') {
    const token = envelope.values.token;
    if (token === undefined) throw new Error('delegated credential envelope missing token');
    return token;
  }
  if (secretBox === undefined) throw new Error('secret box is required for delegated credential');
  return secretBox.open(envelope.sealed);
}

export async function bridgeAuthForResource(
  registry: ServerRegistry,
  resource: string,
  allowedBaseDomains: readonly string[],
  controlPlane: ControlPlaneStore,
): Promise<TenantBridgeAuthConfig | undefined> {
  const tenant = await tenantRefFromResource(resource, allowedBaseDomains, controlPlane);
  if (tenant === undefined) return undefined;
  const target =
    tenant.serverVersion === undefined
      ? await registry.getActiveByTenant(tenant)
      : await registry.getActiveByTenantVersion(tenant, tenant.serverVersion);
  const auth = target?.served.artifact.server.auth;
  if (auth?.kind !== 'bridge') return undefined;
  const variables = await registry.configStore.resolveConfigValues(
    'variable',
    resolveConfigScope(tenant),
  );
  return resolveTenantBridgeAuthVariables(auth, variables);
}

export async function managedSecretForResource(
  registry: ServerRegistry,
  resource: string,
  name: string,
  allowedBaseDomains: readonly string[],
  controlPlane: ControlPlaneStore,
): Promise<string | undefined> {
  const tenant = await tenantRefFromResource(resource, allowedBaseDomains, controlPlane);
  if (tenant === undefined) return undefined;
  const secrets = await registry.configStore.resolveConfigValues(
    'secret',
    resolveConfigScope(tenant),
  );
  return secrets[name];
}

async function tenantRefFromResource(
  resource: string,
  allowedBaseDomains: readonly string[],
  controlPlane: ControlPlaneStore,
): Promise<TenantResourceRef | undefined> {
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return undefined;
  }
  const publicRef =
    allowedBaseDomains.length > 0
      ? parseCanonicalPublicMcpUrl(resource, allowedBaseDomains)
      : undefined;
  if (publicRef !== undefined) return resolveMcpSubdomainTenant(controlPlane, publicRef);
  const resourceHostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const usesPublicHost = allowedBaseDomains.some((candidate) => {
    const base = normalizePublicBaseDomain(candidate);
    return resourceHostname === base || resourceHostname.endsWith(`.${base}`);
  });
  return usesPublicHost ? undefined : parseLegacyTenantMcpPath(url.pathname);
}
