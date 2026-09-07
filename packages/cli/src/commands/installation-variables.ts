import { MAX_VARIABLE_VALUE_BYTES, validateJsonSchema } from '@noodle-borg/compiler';
import {
  ApplicationSettingsClientResponseSchema,
  type ApplicationSettingsProjection,
  ApplicationSettingsSaveRequestSchema,
} from '@noodle-borg/wire-contracts';
import type { ConfigLocation } from '../config.js';
import {
  RefreshTokenRejectedError,
  resolveControlPlaneToken,
  ServiceRequestError,
  serviceJson,
} from '../control-plane.js';
import { renderTable } from '../table.js';
import { EXIT, printJsonOk } from './output.js';
import { stdoutTableOptions } from './resource-shared.js';
import { missingLogin, printCliFailure } from './shared.js';

export interface InstallationVariableArguments {
  readonly installation?: string;
  readonly expectedRevision?: string;
  readonly app?: string;
  readonly targetEnv?: string;
  readonly scope?: string;
  readonly service?: string;
  readonly authToken?: string;
  readonly json?: boolean;
  readonly parseError?: string;
  readonly positional?: readonly string[];
}

/** The existing variable command family projected through installation business authority. */
export async function runInstallationVariables(input: {
  readonly kind: 'secret' | 'variable';
  readonly action: string | undefined;
  readonly name: string | undefined;
  readonly args: InstallationVariableArguments;
  readonly runtime: 'local' | 'cloud' | 'other';
  readonly org: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly home: ConfigLocation;
  readonly readValue: () => Promise<string>;
}): Promise<number> {
  const { args, action, name, org } = input;
  const mutation = action === 'set' || action === 'delete';
  const failure = (code: string, message: string, exitCode: number, fix?: string) =>
    printCliFailure(
      'variables',
      {
        code,
        message,
        cause: message,
        fix:
          fix ??
          'Inspect the installation settings and retry with the current declaration and revision.',
        next: 'noodle variables list --installation <id> --org <org> --runtime cloud --json',
        exitCode,
      },
      args.json === true,
    );
  if (
    input.kind !== 'variable' ||
    input.runtime === 'local' ||
    args.installation === undefined ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(args.installation) ||
    org === undefined ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(org) ||
    org.length > 63 ||
    args.app !== undefined ||
    args.targetEnv !== undefined ||
    args.scope !== undefined ||
    args.parseError !== undefined ||
    (args.positional?.length ?? 0) > 0 ||
    !['list', 'resolve', 'set', 'delete'].includes(action ?? '') ||
    (mutation && name === undefined) ||
    (action === 'list' && name !== undefined) ||
    (args.expectedRevision !== undefined &&
      (!mutation || !/^[a-f0-9]{64}$/.test(args.expectedRevision)))
  )
    return failure(
      'invalid_arguments',
      'Installation variables require cloud/other runtime and organization; app, env, scope and secrets are incompatible.',
      EXIT.USAGE,
      'Use an installation target. An expected revision is valid only for installation set/delete.',
    );

  try {
    const { serviceUrl, token } = await resolveControlPlaneToken({
      serviceFlag: args.service,
      authFlag: args.authToken,
      env: input.env,
      home: input.home,
    });
    if (token === undefined) return missingLogin('variables', args.json);
    const scope = { level: 'installation', org, installation: args.installation };
    const path = `${serviceUrl}/v1/orgs/${encodeURIComponent(org)}/solution-installations/${encodeURIComponent(args.installation)}/settings`;
    const parsed = ApplicationSettingsClientResponseSchema.safeParse(
      await serviceJson(path, token),
    );
    if (!parsed.success)
      return failure(
        'invalid_service_response',
        'The service returned an invalid settings projection.',
        EXIT.FAILURE,
      );
    const current = parsed.data.data;
    const declaration = current.declarations.find((setting) => setting.name === name);
    if (name !== undefined && declaration === undefined)
      return failure(
        'setting_not_declared',
        'The requested name is not a declared business setting.',
        EXIT.USAGE,
      );

    if (!mutation) {
      const settings = inspectSettings(current, name);
      if (args.json)
        printJsonOk({
          runtime: input.runtime,
          service: serviceUrl,
          scope,
          revision: current.revision,
          schemaDigest: current.schemaDigest,
          canEdit: current.canEdit,
          settings,
          readiness: current.readiness,
        });
      else {
        console.log(`installation: ${org}/${args.installation}`);
        console.log(`revision: ${current.revision}`);
        console.log(`can edit: ${current.canEdit ? 'yes' : 'no'}`);
        console.log(
          renderTable(
            [
              { header: 'NAME', get: (row) => row.name },
              { header: 'LABEL', get: (row) => row.label },
              { header: 'SOURCE', get: (row) => row.provenance },
              { header: 'CONFIGURED', get: (row) => (row.configured ? 'yes' : 'no') },
            ],
            settings,
            stdoutTableOptions(),
          ),
        );
        for (const ready of current.readiness)
          console.log(`${ready.tool}: ${ready.ready ? 'ready' : 'configuration required'}`);
      }
      return EXIT.OK;
    }
    if (!current.canEdit)
      return failure(
        'settings_forbidden',
        'An installation business administrator grant is required to change settings.',
        EXIT.AUTH,
      );
    if (args.expectedRevision !== undefined && args.expectedRevision !== current.revision)
      return failure(
        'settings_conflict',
        'The installation settings changed after the supplied revision.',
        EXIT.FAILURE,
      );
    if (name === undefined || declaration === undefined) return EXIT.USAGE;
    let values: Record<string, unknown> = {};
    if (action === 'set') {
      try {
        const raw = await input.readValue();
        if (Buffer.byteLength(raw) > MAX_VARIABLE_VALUE_BYTES) throw new Error('value too large');
        const value: unknown = JSON.parse(raw);
        if (validateJsonSchema(declaration.valueSchema, value).length > 0)
          throw new Error('invalid value');
        values = Object.fromEntries([[name, value]]);
      } catch {
        return failure(
          'invalid_setting_value',
          'The value must be bounded JSON matching the declared setting schema.',
          EXIT.USAGE,
          'Use a JSON value source; string values need JSON quotes. Inspect the schema with installation-scoped variables resolve --json.',
        );
      }
    }
    const update = ApplicationSettingsSaveRequestSchema.safeParse({
      expectedRevision: args.expectedRevision ?? current.revision,
      schemaDigest: current.schemaDigest,
      values,
      ...(action === 'delete' ? { resetKeys: [name] } : {}),
    });
    if (!update.success)
      return failure('settings_invalid', 'The settings update is invalid.', EXIT.USAGE);
    const saved = ApplicationSettingsClientResponseSchema.safeParse(
      await serviceJson(path, token, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(update.data),
      }),
    );
    if (!saved.success)
      return failure(
        'invalid_service_response',
        'The service returned an invalid save response; inspect settings before retrying.',
        EXIT.FAILURE,
      );
    if (args.json)
      printJsonOk({
        runtime: input.runtime,
        service: serviceUrl,
        scope,
        name,
        disposition: action === 'delete' ? 'reset' : 'set',
        revision: saved.data.data.revision,
        schemaDigest: saved.data.data.schemaDigest,
      });
    else
      console.log(
        action === 'delete'
          ? `reset ${name} to its declared default or unset state`
          : `set ${name}`,
      );
    return EXIT.OK;
  } catch (error) {
    if (error instanceof RefreshTokenRejectedError) throw error;
    if (error instanceof ServiceRequestError) {
      if (error.status === 400)
        return failure(
          'settings_invalid',
          'The service rejected the setting declaration or value.',
          EXIT.USAGE,
        );
      if (error.status === 401 || error.status === 403)
        return failure(
          'settings_forbidden',
          'The signed-in identity lacks access to this installation operation.',
          EXIT.AUTH,
        );
      if (error.status === 409)
        return failure(
          'settings_conflict',
          'The installation settings changed; the update was not applied.',
          EXIT.FAILURE,
        );
      if (error.status === 404)
        return failure(
          'installation_not_found',
          'The installation is unavailable in this organization.',
          EXIT.FAILURE,
        );
      if (error.status === 0)
        return failure(
          'settings_unreachable',
          'The settings service could not be reached.',
          EXIT.UNREACHABLE,
        );
    }
    return failure(
      'settings_unavailable',
      'The installation settings operation could not complete.',
      EXIT.FAILURE,
    );
  }
}

function inspectSettings(current: ApplicationSettingsProjection, name: string | undefined) {
  return current.declarations
    .filter((declaration) => name === undefined || declaration.name === name)
    .map((declaration) => ({
      name: declaration.name,
      label: declaration.portal.label,
      ...(declaration.portal.help === undefined ? {} : { help: declaration.portal.help }),
      ...(declaration.portal.group === undefined ? {} : { group: declaration.portal.group }),
      type: String(declaration.valueSchema.type),
      valueSchema: declaration.valueSchema,
      schemaDigest: declaration.schemaDigest,
      requiredFor: declaration.requiredFor,
      provenance: current.provenance[declaration.name] ?? 'unset',
      configured: Object.hasOwn(current.values, declaration.name),
    }));
}
