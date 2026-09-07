import {
  type ArtifactVariableDeclaration,
  canonicalJson,
  MAX_VARIABLE_VALUE_BYTES,
  sha256Canonical,
  validateJsonSchema,
  validateVariableDeclaration,
} from '@noodle-borg/compiler';
import {
  type ApplicationSettingsProjection,
  ApplicationSettingsProjectionSchema,
  type ApplicationSettingsSaveRequest,
  ApplicationSettingsSaveRequestSchema,
} from '@noodle-borg/wire-contracts';
import type { SolutionInstallation } from './business-information/contracts.js';
import {
  type ConfigScope,
  type ConfigStore,
  type ConfigValueInput,
  type ConfigValueMetadata,
  scopeChain,
} from './store/config-values.js';

export interface SettingsTarget {
  readonly scope: Extract<ConfigScope, { level: 'env' }>;
  readonly releaseDigest: string;
  readonly declarations: readonly ArtifactVariableDeclaration[];
}

export function installationSettingsTarget(installation: SolutionInstallation): SettingsTarget {
  return {
    scope: {
      level: 'env',
      org: installation.scope.org,
      app: installation.scope.app,
      env: installation.scope.env,
    },
    releaseDigest: installation.definition.reference.digest,
    declarations: installation.definition.variables ?? [],
  };
}

export class SettingsError extends Error {
  constructor(
    readonly code: 'settings_invalid' | 'settings_conflict' | 'settings_unavailable',
    message: string,
  ) {
    super(message);
  }
}

/** Business settings are a validated projection of the existing hierarchical config authority. */
export class ApplicationSettings {
  constructor(readonly config: ConfigStore) {}

  async initialize(target: SettingsTarget): Promise<void> {
    await this.transaction(target.scope.org, async (transaction) => {
      const exact = await transaction.listConfigValues('variable', target.scope);
      const existing = new Set(exact.map((entry) => entry.name));
      for (const declaration of target.declarations) {
        if (!Object.hasOwn(declaration, 'default') || existing.has(declaration.name)) continue;
        validateValue(declaration, declaration.default);
        await transaction.setConfigValue({
          kind: 'variable',
          scope: target.scope,
          name: declaration.name,
          value: canonicalJson(declaration.default),
          valueOrigin: 'default',
        });
      }
    });
  }

  read(target: SettingsTarget, canEdit: boolean): Promise<ApplicationSettingsProjection> {
    return this.transaction(target.scope.org, (transaction) =>
      projectSettings(transaction, target, canEdit),
    );
  }

  async save(
    target: SettingsTarget,
    request: ApplicationSettingsSaveRequest,
    actor: string,
    resolveTargets?: () => Promise<readonly SettingsTarget[]>,
  ): Promise<ApplicationSettingsProjection> {
    const parsed = ApplicationSettingsSaveRequestSchema.safeParse(request);
    if (!parsed.success) throw new SettingsError('settings_invalid', 'Invalid settings update.');
    return this.transaction(target.scope.org, async (transaction) => {
      const targets = resolveTargets ? await resolveTargets() : [target];
      if (
        !targets.some(
          (entry) =>
            withinScope(target.scope, entry.scope) &&
            entry.releaseDigest === target.releaseDigest &&
            sha256Canonical(entry.declarations) === sha256Canonical(target.declarations),
        )
      )
        throw new SettingsError(
          'settings_conflict',
          'Application release changed. Reload before saving.',
        );
      const current = await projectSettings(transaction, target, true);
      if (
        current.revision !== request.expectedRevision ||
        current.schemaDigest !== request.schemaDigest
      ) {
        throw new SettingsError(
          'settings_conflict',
          'Settings or application release changed. Reload before saving.',
        );
      }
      const declarations = new Map(
        target.declarations
          .filter((entry) => entry.portal !== undefined)
          .map((entry) => [entry.name, entry]),
      );
      for (const [name, value] of Object.entries(request.values)) {
        const declaration = declarations.get(name);
        if (declaration === undefined)
          throw new SettingsError('settings_invalid', 'Setting is not exposed to this business.');
        validateValue(declaration, value);
        await transaction.setConfigValue({
          kind: 'variable',
          scope: target.scope,
          name,
          value: canonicalJson(value),
          updatedBySubject: actor,
        });
      }
      for (const name of request.resetKeys ?? []) {
        const declaration = declarations.get(name);
        if (declaration === undefined)
          throw new SettingsError('settings_invalid', 'Setting is not exposed to this business.');
        if (Object.hasOwn(declaration, 'default')) {
          await transaction.setConfigValue({
            kind: 'variable',
            scope: target.scope,
            name,
            value: canonicalJson(declaration.default),
            valueOrigin: 'default',
            updatedBySubject: actor,
          });
        } else {
          await transaction.deleteConfigValue('variable', target.scope, name);
        }
      }
      for (const entry of targets)
        if (withinScope(target.scope, entry.scope))
          await projectSettings(transaction, entry, false);
      return projectSettings(transaction, target, true);
    });
  }

  /** Technical API/CLI changes share validation and the same hierarchy transaction as Portal. */
  writeTechnical(
    targets: readonly SettingsTarget[] | (() => Promise<readonly SettingsTarget[]>),
    input: Omit<ConfigValueInput, 'value'> & { readonly value?: string },
  ): Promise<ConfigValueMetadata | boolean> {
    return this.transaction(input.scope.org, async (transaction) => {
      const currentTargets = typeof targets === 'function' ? await targets() : targets;
      const affected = currentTargets.filter((target) => withinScope(input.scope, target.scope));
      if (input.kind === 'variable' && input.value !== undefined) {
        for (const target of affected) {
          const declaration = target.declarations.find((entry) => entry.name === input.name);
          if (declaration !== undefined) validateValue(declaration, decodeValue(input.value));
        }
      }
      const result =
        input.value === undefined
          ? await transaction.deleteConfigValue(input.kind, input.scope, input.name)
          : await transaction.setConfigValue({ ...input, value: input.value });
      if (input.kind === 'variable') {
        // Includes reset/delete and changes inherited by multiple installed applications.
        for (const target of affected) await projectSettings(transaction, target, false);
      }
      return result;
    });
  }

  private transaction<T>(org: string, work: (transaction: ConfigStore) => Promise<T>): Promise<T> {
    if (this.config.transactConfig === undefined)
      throw new SettingsError(
        'settings_unavailable',
        'Atomic configuration storage is unavailable.',
      );
    return this.config.transactConfig(org, work);
  }
}

async function projectSettings(
  config: ConfigStore,
  target: SettingsTarget,
  canEdit: boolean,
): Promise<ApplicationSettingsProjection> {
  const rows: ConfigValueMetadata[] = [];
  for (const scope of scopeChain(target.scope))
    rows.push(...(await config.listConfigValues('variable', scope)));
  const declarations = target.declarations.filter((entry) => entry.portal !== undefined);
  const declaredNames = new Set(target.declarations.map((entry) => entry.name));
  const scopedRows = rows.filter((row) => declaredNames.has(row.name));
  const values: Record<string, unknown> = {};
  const provenance: ApplicationSettingsProjection['provenance'] = {};
  const missing = new Map<string, string[]>();
  for (const declaration of target.declarations) {
    const { schemaDigest: _digest, ...manifest } = declaration;
    if (validateVariableDeclaration(manifest).length > 0)
      throw new SettingsError(
        'settings_invalid',
        'Application has an invalid setting declaration.',
      );
    const candidates = scopedRows.filter((row) => row.name === declaration.name);
    const chosen =
      candidates.filter((row) => row.valueOrigin !== 'default').at(-1) ?? candidates.at(-1);
    const value = chosen?.value === undefined ? declaration.default : decodeValue(chosen.value);
    if (value !== undefined) validateValue(declaration, value);
    if (declaration.portal !== undefined) {
      if (value !== undefined) values[declaration.name] = value;
      provenance[declaration.name] =
        chosen?.valueOrigin === 'default' || (chosen === undefined && value !== undefined)
          ? 'default'
          : chosen?.scope.level === 'org'
            ? 'organization'
            : chosen?.scope.level === 'app'
              ? 'app'
              : chosen !== undefined
                ? 'operator'
                : 'unset';
      for (const tool of declaration.requiredFor) {
        const names = missing.get(tool) ?? [];
        if (value === undefined) names.push(declaration.name);
        missing.set(tool, names);
      }
    }
  }
  const schemaDigest = sha256Canonical(target.declarations);
  return ApplicationSettingsProjectionSchema.parse({
    revision: sha256Canonical({ release: target.releaseDigest, schemaDigest, rows: scopedRows }),
    schemaDigest,
    releaseDigest: target.releaseDigest,
    declarations,
    values,
    provenance,
    readiness: [...missing.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tool, names]) => ({ tool, ready: names.length === 0, missing: names })),
    canEdit,
  });
}

function decodeValue(value: string): unknown {
  if (Buffer.byteLength(value) > MAX_VARIABLE_VALUE_BYTES)
    throw new SettingsError('settings_invalid', 'Setting exceeds the maximum value size.');
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new SettingsError('settings_invalid', 'Declared setting values must be encoded as JSON.');
  }
}

function validateValue(declaration: ArtifactVariableDeclaration, value: unknown): void {
  const serialized = canonicalJson(value);
  if (
    Buffer.byteLength(serialized) > MAX_VARIABLE_VALUE_BYTES ||
    validateJsonSchema(declaration.valueSchema, value).length > 0
  ) {
    throw new SettingsError(
      'settings_invalid',
      `Invalid value for ${declaration.portal?.label ?? declaration.name}.`,
    );
  }
}

function withinScope(parent: ConfigScope, child: SettingsTarget['scope']): boolean {
  return (
    parent.org === child.org &&
    (parent.level === 'org' ||
      (parent.app === child.app && (parent.level === 'app' || parent.env === child.env)))
  );
}
