import {
  NativeRecordLifecycleClientResponseSchema,
  NativeRecordLifecyclePreviewClientResponseSchema,
  NativeRecordLifecyclePreviewSchema,
} from '@noodle-borg/wire-contracts';
import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, serviceJson } from '../control-plane.js';
import { EXIT, printJsonOk } from './output.js';
import {
  authRequired,
  parseCommandFlags,
  printCliFailure,
  serviceFailure,
  usageError,
} from './shared.js';

export async function runSolutionNativeLifecycle(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  location: ConfigLocation,
  options: { readonly fetchImpl?: typeof fetch },
): Promise<number> {
  const command = 'solutions records lifecycle';
  const args = parseCommandFlags(rest, {
    values: {
      '--service': 'service',
      '--auth-token': 'authToken',
      '--org': 'org',
      '--preview': 'preview',
    },
    booleans: { '--json': 'json', '--confirm': 'confirm' },
  });
  const [operation, installation, ...extra] = args.positional;
  const invalid = (message: string) =>
    printCliFailure(
      command,
      usageError(
        message,
        'noodle solutions records lifecycle <preview|migrate> <installation> --org <org> [--preview <json> --confirm] [--json]',
      ),
      args.json,
    );
  if (
    args.parseError ||
    !operation ||
    !['preview', 'migrate'].includes(operation) ||
    !installation ||
    !args.org ||
    extra.length
  )
    return invalid(
      args.parseError ?? 'Supply an operation, installation and explicit organization.',
    );
  if (operation === 'preview' && (args.preview !== undefined || args.confirm))
    return invalid('Preview does not accept --preview or --confirm.');
  let preview: typeof NativeRecordLifecyclePreviewSchema._output | undefined;
  if (operation === 'migrate') {
    if (!args.confirm) return invalid('--confirm is required after reviewing the migration.');
    try {
      if (!args.preview || Buffer.byteLength(args.preview, 'utf8') > 64 * 1024)
        return invalid('--preview must contain the bounded preview JSON returned by the service.');
      const parsed = NativeRecordLifecyclePreviewSchema.safeParse(JSON.parse(args.preview));
      if (!parsed.success) return invalid('--preview must contain a valid lifecycle preview.');
      preview = parsed.data;
    } catch {
      return invalid('--preview must contain valid JSON.');
    }
  }
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service,
    authFlag: args.authToken,
    env,
    home: location,
  });
  if (!resolved.token) return printCliFailure(command, authRequired(), args.json);
  try {
    const result = await serviceJson<unknown>(
      `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(args.org)}/solution-installations/${encodeURIComponent(installation)}/record-lifecycle`,
      resolved.token,
      {
        method: operation === 'preview' ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        ...(preview ? { body: JSON.stringify({ preview, confirm: true }) } : {}),
      },
      options.fetchImpl ?? fetch,
    );
    if (operation === 'preview') {
      const data = NativeRecordLifecyclePreviewClientResponseSchema.parse(result).data;
      if (args.json) printJsonOk(data);
      else
        console.log(
          `${data.policy === 'explicit_erasure' ? 'Records remain until explicitly erased.' : `Review: preserve ${data.recordsToPreserve} available records; ${data.expiredRecords} already expired records will not be restored.`}\nPreview JSON (valid for five minutes): ${JSON.stringify(data)}`,
        );
    } else {
      const data = NativeRecordLifecycleClientResponseSchema.parse(result).data;
      if (args.json) printJsonOk(data);
      else
        console.log(
          `Records remain until explicitly erased. ${data.recordsPreserved} available records preserved.${data.replayed ? ' Previously confirmed change.' : ''}`,
        );
    }
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      command,
      serviceFailure(command, error, 'noodle solutions records lifecycle --help'),
      args.json,
    );
  }
}
