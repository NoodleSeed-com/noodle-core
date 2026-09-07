import {
  type ArtifactVariableDeclaration,
  type CompileError,
  compileVariableDeclarations,
  manifestSchema,
  sha256Canonical,
} from '@noodle-borg/compiler';
import { parse as parseYaml } from 'yaml';
import {
  installationSettingsTarget,
  SettingsError,
  type SettingsTarget,
} from './application-settings.js';
import type { BusinessInformationStore } from './business-information/contracts.js';
import { normalizePersistedManifestForCompile } from './manifest-normalize.js';
import type { ServerRegistry } from './registry.js';
import type { ConfigScope } from './store.js';

/** Include active deployments and pinned installations before a hierarchical technical mutation. */
export async function resolveSettingsTargets(
  registry: ServerRegistry,
  scope: ConfigScope,
  installations?: BusinessInformationStore,
): Promise<readonly SettingsTarget[]> {
  const result: SettingsTarget[] = [];
  for (const installation of (await installations?.listInstallations(scope.org)) ?? []) {
    if (scope.level !== 'org' && installation.scope.app !== scope.app) continue;
    if (scope.level === 'env' && installation.scope.env !== scope.env) continue;
    result.push(installationSettingsTarget(installation));
  }
  let apps: readonly string[];
  if (scope.level !== 'org') apps = [scope.app];
  else {
    const listed = await registry.listApps(scope.org, { limit: 1000 });
    if (listed.truncated)
      throw new SettingsError(
        'settings_unavailable',
        'Configuration target inventory is incomplete. Use a narrower scope.',
      );
    apps = listed.apps.map((app) => app.appSlug);
  }
  for (const app of apps) {
    const environments =
      scope.level === 'env'
        ? [scope.env]
        : (await registry.listEnvironments(scope.org, app)).map((env) => env.envName);
    for (const env of environments) {
      for (const deployment of await registry.listDeployments({ org: scope.org, app, env })) {
        if (!deployment.active) continue;
        const target = await registry.getDeploymentSource(
          { org: scope.org, app, env },
          deployment.deploymentId,
        );
        if (target === undefined || target.serverVersion !== deployment.serverVersion)
          throw new SettingsError(
            'settings_unavailable',
            'Application settings inventory changed.',
          );
        const declarations = persistedVariableDeclarations(target.manifest);
        if (declarations.length === 0) continue;
        result.push({
          scope: { level: 'env', org: scope.org, app, env },
          releaseDigest: sha256Canonical({ deploymentId: deployment.deploymentId, declarations }),
          declarations,
        });
      }
    }
  }
  return result;
}

/** Read only the canonical declaration contract; never construct a runtime or open provider secrets
 * while the organization configuration lock is held. Invalid persisted declarations fail closed. */
function persistedVariableDeclarations(source: string): readonly ArtifactVariableDeclaration[] {
  try {
    const normalized = normalizePersistedManifestForCompile(source);
    let raw: unknown;
    try {
      raw = JSON.parse(normalized);
    } catch {
      raw = parseYaml(normalized);
    }
    const manifest = manifestSchema.parse(raw);
    const errors: CompileError[] = [];
    const declarations = compileVariableDeclarations(
      manifest.manifestVersion === '2' ? (manifest.server.variables ?? []) : [],
      manifest.tools.map((tool) => tool.name),
      errors,
    );
    if (errors.length > 0) throw new Error('invalid persisted setting declaration');
    return declarations;
  } catch {
    // YAML/schema errors can contain document excerpts; never forward them to a config caller.
    throw new SettingsError('settings_unavailable', 'Stored application settings are invalid.');
  }
}
