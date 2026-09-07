import { dirname, resolve } from 'node:path';
import { noodlePlatformCatalog } from '@noodle-borg/authoring';
import { compile, InMemoryCatalog } from '@noodle-borg/compiler';
import {
  compileConnectors,
  delegatedTokenExchangeIdentityErrors,
} from '@noodle-borg/connector-defs';
import type { ConfigLocation } from '../config.js';
import { readDeployInput } from '../deploy.js';
import { resolveLocalEntrypoint, resolveLocalEntrypointResult } from '../project.js';
import { runGoogleAuth } from './auth-google-ops.js';
import { liveAuthDoctorChecks } from './auth-live-doctor.js';
import {
  type AuthDoctorCheck,
  authDiagnosticAudience,
  authDiagnosticUrl,
  oidcMetadataChecks,
} from './auth-metadata-readiness.js';
import { runAuthServicePrincipals } from './auth-service-principals.js';
import { normalizeCommandServerVersion } from './deploy-version-resolution.js';
import { EXIT, printJsonFailure, printJsonOk } from './output.js';
import {
  type CliFailure,
  configuredProjectEntrypointMissing,
  missingProjectEntrypoint,
  parseCommandFlags,
  printCliFailure,
  usageError,
} from './shared.js';

interface AuthDoctorArgs {
  readonly entrypoint?: string;
  readonly json: boolean;
  readonly live: boolean;
  readonly org?: string;
  readonly app?: string;
  readonly targetEnv?: string;
  readonly serverVersion?: string;
  readonly service?: string;
  /** Trusted loopback Devtools supplies the verified caller outside the authored server. */
  readonly localDevtoolsCustomerIdentity?: boolean;
}
type ParsedAuthDoctorArgs = AuthDoctorArgs & { readonly failure?: CliFailure };
const AUTH_DOCTOR_USAGE_NEXT = 'noodle auth doctor app/server.ts --json';

export async function runAuth(
  rest: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  home?: ConfigLocation,
): Promise<number> {
  const [subcommand, ...tail] = rest;
  if (subcommand === 'doctor') return runAuthDoctor(tail, env, home);
  if (subcommand === 'google') return runGoogleAuth(tail, env, home ?? env.HOME ?? '');
  if (subcommand === 'service-principals') {
    return runAuthServicePrincipals(tail, env, home ?? env.HOME ?? '');
  }
  console.error(
    'usage: noodle auth doctor [entrypoint] [--live] [--version <version>] [--json]\n' +
      '       noodle auth google prepare|status|revoke ...\n' +
      '       noodle auth service-principals create|list|show|grant|revoke-grant|add-jwk|create-secret|revoke-credential|revoke ...',
  );
  return 2;
}

async function runAuthDoctor(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation = env.HOME ?? '',
): Promise<number> {
  const args = parseArgs(rest);
  if (args.failure !== undefined) return printCliFailure('auth doctor', args.failure, args.json);
  const serverVersion = normalizeCommandServerVersion('auth doctor', args.serverVersion, args.json);
  if (!serverVersion.ok) return serverVersion.exitCode;
  const normalizedArgs: AuthDoctorArgs = {
    ...args,
    ...(serverVersion.value === undefined ? {} : { serverVersion: serverVersion.value }),
  };
  let doctorArgs = normalizedArgs;
  if (doctorArgs.entrypoint === undefined) {
    const resolution = resolveLocalEntrypointResult();
    if (resolution === undefined) return missingProjectEntrypoint('auth doctor', doctorArgs.json);
    if (!resolution.exists) {
      return configuredProjectEntrypointMissing('auth doctor', resolution, doctorArgs.json);
    }
    doctorArgs = { ...doctorArgs, entrypoint: resolution.path };
  }
  const checks = await staticAuthDoctor(doctorArgs);
  if (doctorArgs.live && !checks.some((check) => check.level === 'FAIL')) {
    checks.push(...(await liveAuthDoctorChecks(doctorArgs, env, home)));
  }
  return finish(checks, args.json);
}

async function staticAuthDoctor(args: AuthDoctorArgs): Promise<AuthDoctorCheck[]> {
  const entrypoint = args.entrypoint ?? resolveLocalEntrypoint();
  const checks: AuthDoctorCheck[] = [];
  if (entrypoint === undefined) {
    checks.push({
      code: 'auth_entrypoint_missing',
      level: 'FAIL',
      name: 'Entrypoint',
      message: 'missing',
      fix: 'Pass a server.ts entrypoint or run noodle link --entrypoint <path>.',
    });
    return checks;
  }

  let input: Awaited<ReturnType<typeof readDeployInput>>;
  try {
    input = await readDeployInput(entrypoint);
  } catch (error) {
    checks.push({
      code: 'auth_entrypoint_load',
      level: 'FAIL',
      name: 'Entrypoint',
      message: error instanceof Error ? error.message : String(error),
      fix: 'Fix the authored server module before diagnosing auth.',
    });
    return checks;
  }

  const connectorCatalog =
    input.connectors === undefined ? undefined : compileConnectors(input.connectors);
  if (connectorCatalog !== undefined && !connectorCatalog.ok) {
    const first = connectorCatalog.errors[0];
    checks.push({
      code: 'auth_compile',
      level: 'FAIL',
      name: 'Compile',
      message:
        first !== undefined
          ? `${first.code}${first.path ? ` at ${first.path}` : ''}: ${first.message}`
          : 'connector catalog did not compile',
      fix: 'Run noodle validate and fix the connector catalog before diagnosing auth.',
    });
    return checks;
  }
  const compiled = compile(input.manifest, {
    catalog: new InMemoryCatalog([
      ...noodlePlatformCatalog,
      ...(connectorCatalog?.ok ? connectorCatalog.catalog : []),
    ]),
    localAssets: {
      rootDir: dirname(resolve(entrypoint)),
      publicOrigin: 'http://127.0.0.1',
    },
    knowledgeFiles: { rootDir: dirname(resolve(entrypoint)) },
  });
  if (!compiled.ok) {
    const first = compiled.errors[0];
    checks.push({
      code: 'auth_compile',
      level: 'FAIL',
      name: 'Compile',
      message:
        first !== undefined
          ? `${first.code}${first.path ? ` at ${first.path}` : ''}: ${first.message}`
          : 'manifest did not compile',
      fix: 'Run noodle validate and fix the manifest before diagnosing auth.',
    });
    return checks;
  }

  const auth = compiled.artifact.server.auth;
  const identityErrors = delegatedTokenExchangeIdentityErrors(
    connectorCatalog?.ok ? connectorCatalog.secretBindings : [],
    compiled.artifact.server,
    args.localDevtoolsCustomerIdentity === true ? { localDevtoolsCustomerIdentity: true } : {},
  );
  checks.push(
    ...identityErrors.map((error) => ({
      code: error.code,
      level: 'FAIL' as const,
      name: 'Customer identity source',
      message: error.message,
      fix: 'Declare server.auth with customerAuth(...) or server.assistant with embeddedAssistant(...), then rerun noodle auth doctor.',
    })),
  );
  checks.push(...delegatedConnectorChecks(input.connectors, auth, identityErrors.length === 0));
  if (auth === undefined) {
    checks.push({
      code: 'customer_auth_missing',
      level: 'WARN',
      name: 'Customer auth',
      message: 'not configured',
      fix: 'Use customerAuth.federatedOidc(...), customerAuth.oidc(...), or a built-in provider adapter before deploying with --access customers.',
    });
    return checks;
  }

  if (auth.kind === 'bridge') {
    checks.push({
      code: 'customer_auth_bridge',
      level: 'PASS',
      name: 'Customer auth',
      message: `bridge provider "${auth.provider}"`,
    });
    if (auth.provider === 'firebase') {
      checks.push({
        code: 'firebase_project',
        level: typeof auth.projectId === 'string' && auth.projectId.length > 0 ? 'PASS' : 'FAIL',
        name: 'Firebase project',
        message:
          typeof auth.projectId === 'string' && auth.projectId.length > 0
            ? auth.projectId
            : 'missing projectId',
        ...(typeof auth.projectId === 'string' && auth.projectId.length > 0
          ? {}
          : { fix: 'Set customerAuth.firebase({ projectId, apiKey }).' }),
      });
      checks.push({
        code: 'firebase_api_key',
        level: typeof auth.apiKey === 'string' && auth.apiKey.length > 0 ? 'PASS' : 'FAIL',
        name: 'Firebase Web API key',
        message:
          typeof auth.apiKey === 'string' && auth.apiKey.length > 0
            ? 'configured'
            : 'missing apiKey',
        ...(typeof auth.apiKey === 'string' && auth.apiKey.length > 0
          ? {}
          : { fix: 'Set customerAuth.firebase({ projectId, apiKey }).' }),
      });
      checks.push({
        code: 'firebase_auth_domain',
        level: 'PASS',
        name: 'Firebase auth domain',
        message:
          typeof auth.authDomain === 'string' && auth.authDomain.length > 0
            ? auth.authDomain
            : `${auth.projectId}.firebaseapp.com`,
      });
      checks.push({
        code: 'firebase_authorize_url',
        level:
          typeof auth.authorizeUrl === 'string' && auth.authorizeUrl.startsWith('https://')
            ? 'WARN'
            : 'PASS',
        name: 'Firebase authorize URL',
        message:
          typeof auth.authorizeUrl === 'string' && auth.authorizeUrl.startsWith('https://')
            ? 'legacy override configured'
            : 'Noodle Cloud-hosted bridge',
      });
      checks.push({
        code: 'firebase_revocation',
        level: 'WARN',
        name: 'Revocation checks',
        message: 'Firebase ID token revocation is not checked in v1',
      });
    } else if (auth.provider === 'microsoft') {
      checks.push({
        code: 'microsoft_tenant',
        level: typeof auth.tenantId === 'string' && auth.tenantId.length > 0 ? 'PASS' : 'FAIL',
        name: 'Microsoft tenant',
        message:
          typeof auth.tenantId === 'string' && auth.tenantId.length > 0
            ? auth.tenantId
            : 'missing tenantId',
        ...(typeof auth.tenantId === 'string' && auth.tenantId.length > 0
          ? {}
          : { fix: 'Set customerAuth.microsoft({ tenantId, clientId, clientSecret }).' }),
      });
      checks.push({
        code: 'microsoft_client_id',
        level: typeof auth.clientId === 'string' && auth.clientId.length > 0 ? 'PASS' : 'FAIL',
        name: 'Microsoft client id',
        message:
          typeof auth.clientId === 'string' && auth.clientId.length > 0
            ? 'configured'
            : 'missing clientId',
        ...(typeof auth.clientId === 'string' && auth.clientId.length > 0
          ? {}
          : { fix: 'Set customerAuth.microsoft({ tenantId, clientId, clientSecret }).' }),
      });
      checks.push({
        code: 'microsoft_client_secret',
        level:
          typeof auth.clientSecret === 'string' && auth.clientSecret.length > 0 ? 'PASS' : 'FAIL',
        name: 'Microsoft client secret',
        message:
          typeof auth.clientSecret === 'string' && auth.clientSecret.length > 0
            ? `managed secret ${auth.clientSecret}`
            : 'missing clientSecret',
        ...(typeof auth.clientSecret === 'string' && auth.clientSecret.length > 0
          ? {}
          : { fix: 'Set clientSecret: secret("MICROSOFT_CLIENT_SECRET").' }),
      });
      checks.push({
        code: 'microsoft_token_endpoint',
        level: 'PASS',
        name: 'Microsoft token endpoint',
        message:
          typeof auth.tokenUrl === 'string' && auth.tokenUrl.length > 0
            ? auth.tokenUrl
            : 'derived from tenantId',
      });
      checks.push({
        code: 'microsoft_scopes',
        level: Array.isArray(auth.scopes) && auth.scopes.length > 0 ? 'PASS' : 'WARN',
        name: 'Microsoft delegated scopes',
        message:
          Array.isArray(auth.scopes) && auth.scopes.length > 0
            ? auth.scopes.join(' ')
            : 'default OIDC/offline_access scopes only',
        ...(Array.isArray(auth.scopes) && auth.scopes.length > 0
          ? {}
          : { fix: 'Add the Graph or SharePoint delegated scopes your tools require.' }),
      });
    } else {
      checks.push({
        code: 'bridge_verifier',
        level: auth.verifyUrl === undefined ? 'WARN' : 'PASS',
        name: 'Bridge verifier',
        message: auth.verifyUrl ?? 'not configured yet',
        ...(auth.verifyUrl === undefined
          ? {
              fix: 'Add a verifyUrl or choose a built-in provider adapter before hosted bridge login.',
            }
          : {}),
      });
    }
    checks.push({
      code: 'mcp_bridge_issuer',
      level: 'PASS',
      name: 'MCP issuer',
      message: 'Noodle-managed bridge authorization server',
    });
    return checks;
  }

  if (auth.kind === 'federatedOidc') {
    checks.push({
      code: 'customer_auth_federated_oidc',
      level: 'PASS',
      name: 'Customer auth',
      message: `federated OIDC (${auth.issuers.length} issuer${auth.issuers.length === 1 ? '' : 's'})`,
    });
    for (const issuer of auth.issuers) {
      const diagnosticIssuer = authDiagnosticUrl(issuer.issuer);
      checks.push({
        code: 'customer_auth_issuer',
        level: 'PASS',
        name: 'Issuer',
        issuer: diagnosticIssuer,
        message: diagnosticIssuer,
      });
      checks.push({
        code: 'customer_auth_audience',
        level: 'PASS',
        name: 'Audience',
        issuer: diagnosticIssuer,
        message: authDiagnosticAudience(issuer.audience),
      });
      checks.push(
        ...(await oidcMetadataChecks(issuer.issuer)).map((check) => ({
          ...check,
          name: `${check.name} (${diagnosticIssuer})`,
        })),
      );
    }
    return checks;
  }

  checks.push({
    code: 'customer_auth_oidc',
    level: 'PASS',
    name: 'Customer auth',
    message: 'oidc',
  });
  checks.push({
    code: 'customer_auth_issuer',
    level: 'PASS',
    name: 'Issuer',
    issuer: authDiagnosticUrl(auth.issuer),
    message: authDiagnosticUrl(auth.issuer),
  });
  checks.push({
    code: 'customer_auth_audience',
    level: 'PASS',
    name: 'Audience',
    issuer: authDiagnosticUrl(auth.issuer),
    message: authDiagnosticAudience(auth.audience),
  });
  checks.push(...(await oidcMetadataChecks(auth.issuer)));
  return checks;
}

/** Failures that must be cleared before an interactive local host preview can claim OAuth readiness. */
export async function genericHostAuthReadiness(
  entrypoint: string,
): Promise<readonly AuthDoctorCheck[]> {
  const readiness = await authReadinessForEntrypoint(entrypoint, true);
  return readiness.checks.filter((check) => check.level === 'FAIL');
}

export interface AuthReadiness {
  readonly ready: boolean;
  readonly checks: readonly AuthDoctorCheck[];
}

export async function authReadinessForEntrypoint(
  entrypoint: string,
  localDevtoolsCustomerIdentity = false,
): Promise<AuthReadiness> {
  const checks = await staticAuthDoctor({
    entrypoint,
    json: false,
    live: false,
    ...(localDevtoolsCustomerIdentity ? { localDevtoolsCustomerIdentity: true } : {}),
  });
  return {
    ready: !checks.some((check) => check.level === 'FAIL'),
    checks,
  };
}

/**
 * Report delegated connector auth readiness (ADR 0152 / ADR 0092): the token-exchange contract the
 * downstream endpoint must implement, and whether managed delegated providers pair with the declared
 * customer auth (Firebase/Microsoft delegation only works for callers verified by the matching bridge).
 */
function delegatedConnectorChecks(
  connectors: string | undefined,
  auth: { readonly kind?: string | undefined; readonly provider?: string | undefined } | undefined,
  tokenExchangeIdentityReady = true,
): AuthDoctorCheck[] {
  if (connectors === undefined || connectors.trim() === '') return [];
  const compiled = compileConnectors(connectors);
  if (!compiled.ok) {
    const first = compiled.errors[0];
    return [
      {
        code: 'connector_auth_compile',
        level: 'FAIL',
        name: 'Connector auth',
        message:
          first !== undefined
            ? `${first.code}${first.path ? ` at ${first.path}` : ''}: ${first.message}`
            : 'connectors did not compile',
        fix: 'Run noodle validate and fix the connector declarations before diagnosing auth.',
      },
    ];
  }
  const checks: AuthDoctorCheck[] = [];
  let hasTokenExchange = false;
  for (const binding of compiled.secretBindings) {
    if (binding.authKind === 'delegatedTokenExchange' && binding.tokenExchange !== undefined) {
      hasTokenExchange = true;
      if (tokenExchangeIdentityReady) {
        checks.push({
          code: 'delegated_token_exchange',
          level: 'PASS',
          name: 'Delegated token exchange',
          message: `${binding.connectorId} → ${binding.tokenExchange.tokenUrl} (client secret ${binding.secretRef ?? 'missing'})`,
        });
      }
    }
    if (binding.authKind === 'delegatedOAuth' && binding.delegated !== undefined) {
      const provider = binding.delegated.provider;
      const paired = auth?.kind === 'bridge' && auth.provider === provider;
      checks.push({
        code: 'delegated_provider_pairing',
        level: paired ? 'PASS' : 'FAIL',
        name: 'Delegated provider pairing',
        message: paired
          ? `${binding.connectorId} (${provider}) pairs with its managed customerAuth adapter`
          : `${binding.connectorId} uses delegated provider "${provider}" but server auth is ${auth === undefined ? 'not configured' : `${auth.kind ?? 'unknown'}${auth.provider !== undefined ? ` (${auth.provider})` : ''}`}`,
        ...(paired
          ? {}
          : {
              fix: `Declare the matching customerAuth (provider "${provider}") so the broker can resolve delegated credentials, or use delegatedTokenExchange for a customer-owned token endpoint.`,
            }),
      });
    }
  }
  if (hasTokenExchange && tokenExchangeIdentityReady) {
    checks.push({
      code: 'downstream_verification',
      level: 'PASS',
      name: 'Downstream verification',
      message:
        'your token endpoint must verify platform assertions against the deployment issuer JWKS',
      fix: 'See the embedded-assistant Agent Kit reference, "Delegated downstream auth (token exchange)".',
    });
  }
  return checks;
}

function parseArgs(rest: readonly string[]): ParsedAuthDoctorArgs {
  const parsed = parseCommandFlags(rest, {
    values: {
      '--org': 'org',
      '--app': 'app',
      '--env': 'targetEnv',
      '--version': 'serverVersion',
      '--service': 'service',
    },
    booleans: { '--json': 'json', '--live': 'live' },
  });
  const failure =
    parsed.parseError !== undefined
      ? usageError(parsed.parseError, AUTH_DOCTOR_USAGE_NEXT)
      : parsed.positional.length > 1
        ? usageError(
            'auth doctor accepts at most one positional entrypoint',
            AUTH_DOCTOR_USAGE_NEXT,
          )
        : undefined;
  const entrypoint = parsed.positional[0];
  return {
    ...(entrypoint !== undefined ? { entrypoint } : {}),
    json: parsed.json,
    live: parsed.live,
    ...(parsed.org !== undefined ? { org: parsed.org } : {}),
    ...(parsed.app !== undefined ? { app: parsed.app } : {}),
    ...(parsed.targetEnv !== undefined ? { targetEnv: parsed.targetEnv } : {}),
    ...(parsed.serverVersion !== undefined ? { serverVersion: parsed.serverVersion } : {}),
    ...(parsed.service !== undefined ? { service: parsed.service } : {}),
    ...(failure === undefined ? {} : { failure }),
  };
}

function finish(checks: readonly AuthDoctorCheck[], json: boolean): number {
  if (json) {
    if (checks.some((check) => check.level === 'FAIL')) {
      printJsonFailure(
        {
          code: 'auth_doctor_failed',
          message: 'Authentication readiness checks failed.',
          fix: 'Repair each failed check, then rerun auth doctor.',
          next: 'noodle auth doctor --json',
          detail: { checks },
        },
        EXIT.FAILURE,
      );
    } else {
      printJsonOk({ checks });
    }
  } else {
    for (const check of checks) {
      console.log(`${check.level} ${check.name}: ${check.message}`);
      if (check.fix !== undefined) console.log(`  Fix: ${check.fix}`);
    }
  }
  return checks.some((check) => check.level === 'FAIL') ? 1 : 0;
}
