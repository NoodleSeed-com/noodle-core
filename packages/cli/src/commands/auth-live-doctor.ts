import type { ConfigLocation } from '../config.js';
import { readConfig, resolveServiceUrl } from '../config.js';
import { DEFAULT_SERVICE_URL } from '../deploy.js';
import { currentCliVersion } from '../update.js';
import type { AuthDoctorCheck } from './auth-metadata-readiness.js';
import { resolveTenantTarget } from './shared.js';

interface LiveAuthDoctorArgs {
  readonly org?: string;
  readonly app?: string;
  readonly targetEnv?: string;
  readonly serverVersion?: string;
  readonly service?: string;
}

interface LiveAuthDoctorResponse {
  readonly ok?: boolean;
  readonly error?: string;
  readonly resource?: string;
  readonly checks?: readonly {
    readonly connectorId?: string;
    readonly operation?: string;
    readonly authKind?: string;
    readonly ok?: boolean;
    readonly reason?: string;
    readonly fix?: string;
  }[];
}

export async function liveAuthDoctorChecks(
  args: LiveAuthDoctorArgs,
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<AuthDoctorCheck[]> {
  const target = resolveTenantTarget(args, home);
  if (!target.ok) {
    return [
      {
        code: 'live_target',
        level: 'FAIL',
        name: 'Live exchange',
        message: target.error.message,
        fix: target.error.fix,
      },
    ];
  }
  const token = env.NOODLE_CUSTOMER_TOKEN;
  if (!token) {
    return [
      {
        code: 'live_customer_token',
        level: 'FAIL',
        name: 'Live customer token',
        message: 'NOODLE_CUSTOMER_TOKEN is not set',
        fix: 'Set NOODLE_CUSTOMER_TOKEN to a short-lived bearer token for a real customer caller.',
      },
    ];
  }
  const service =
    target.serviceUrl ??
    resolveServiceUrl(args.service, env, readConfig(home)) ??
    DEFAULT_SERVICE_URL;
  const url =
    `${service.replace(/\/+$/, '')}/v1/orgs/${encodeURIComponent(target.org)}` +
    `/apps/${encodeURIComponent(target.app)}/envs/${encodeURIComponent(target.env)}/auth/doctor` +
    (args.serverVersion === undefined ? '' : `?version=${encodeURIComponent(args.serverVersion)}`);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'x-noodle-cli-version': currentCliVersion(),
      },
    });
  } catch (error) {
    return [
      {
        code: 'live_exchange',
        level: 'FAIL',
        name: 'Live exchange',
        message: error instanceof Error ? error.message : String(error),
        fix: 'Check the service URL and network connection.',
      },
    ];
  }
  const body = (await response.json().catch(() => ({}))) as LiveAuthDoctorResponse;
  if (!response.ok) {
    return [
      {
        code: 'live_exchange',
        level: 'FAIL',
        name: 'Live exchange',
        message: body.error ?? `HTTP ${response.status}`,
        fix:
          response.status === 401
            ? 'Configure the IdP to validate this exact MCP resource and map it to the stable audience declared in customerAuth, then mint a fresh customer token.'
            : 'Check the deployed customer auth and delegated connector configuration.',
      },
    ];
  }
  const checks: AuthDoctorCheck[] = (body.checks ?? []).map((check) => ({
    code: 'live_delegated_exchange',
    level: check.ok ? 'PASS' : 'FAIL',
    name: `Live ${check.authKind ?? 'delegated credential'}`,
    message:
      [check.connectorId, check.operation].filter(Boolean).join('.') +
      (check.reason ? `: ${check.reason}` : ''),
    ...(check.fix ? { fix: check.fix } : {}),
  }));
  if (checks.length === 0) {
    checks.push({
      code: 'live_exchange',
      level: 'PASS',
      name: 'Live exchange',
      message: 'customer identity verified; no delegated connector bindings are configured',
    });
  }
  if (body.resource) {
    checks.unshift({
      code: 'live_customer_resource',
      level: 'PASS',
      name: 'Live customer resource',
      message: body.resource,
    });
  }
  return checks;
}
