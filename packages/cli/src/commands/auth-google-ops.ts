import type { ConfigLocation } from '../config.js';
import {
  RefreshTokenRejectedError,
  resolveControlPlaneToken,
  serviceJson,
} from '../control-plane.js';
import { EXIT, printJsonFailure, printJsonOk } from './output.js';
import { missingLogin, printCliFailure, resolveTenantTarget, serviceFailure } from './shared.js';

interface GoogleIdentityResponse {
  readonly ok: true;
  readonly data: {
    readonly status: 'active' | 'revoked';
    readonly subject: string;
    readonly issuer: string;
    readonly oidcDiscoveryUrl: string;
    readonly jwksUrl: string;
    readonly attributeMapping: Readonly<Record<string, string>>;
    readonly attributeCondition: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
}

interface GoogleAuthArgs {
  readonly org?: string;
  readonly app?: string;
  readonly targetEnv?: string;
  readonly service?: string;
  readonly authToken?: string;
  readonly projectNumber?: string;
  readonly pool?: string;
  readonly provider?: string;
  readonly serviceAccount?: string;
  readonly json: boolean;
}

interface GoogleDoctorResponse {
  readonly ok: boolean;
  readonly checks: readonly {
    readonly connectorId?: string;
    readonly operation?: string;
    readonly authKind?: string;
    readonly ok?: boolean;
    readonly reason?: string;
    readonly fix?: string;
  }[];
}

export async function runGoogleAuth(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const [action, ...tail] = rest;
  const json = rest.includes('--json');
  if (action !== 'prepare' && action !== 'status' && action !== 'revoke' && action !== 'doctor') {
    return googleUsageFailure(
      json,
      'usage_error',
      'auth google requires prepare, status, doctor, or revoke',
      true,
      false,
    );
  }
  const args = parseGoogleArgs(tail);
  if (
    action === 'prepare' &&
    (args.projectNumber === undefined || args.pool === undefined || args.provider === undefined)
  ) {
    return googleUsageFailure(
      args.json,
      'missing_google_setup',
      'Google setup requires --project-number, --pool, and --provider. Add --service-account for impersonation.',
    );
  }
  if (action === 'prepare') {
    const invalid = validateGoogleSetupArgs(args);
    if (invalid !== undefined) {
      return googleUsageFailure(args.json, 'invalid_google_setup', invalid, false);
    }
  }
  const target = resolveTenantTarget(args, home);
  if (!target.ok) return printCliFailure(`auth google ${action}`, target.error, args.json);
  let resolved: Awaited<ReturnType<typeof resolveControlPlaneToken>>;
  try {
    resolved = await resolveControlPlaneToken({
      serviceFlag: args.service ?? target.serviceUrl,
      authFlag: args.authToken,
      env,
      home,
    });
  } catch (error) {
    if (error instanceof RefreshTokenRejectedError) throw error;
    return printCliFailure(
      `auth google ${action}`,
      serviceFailure(`auth google ${action}`, error, 'noodle login'),
      args.json,
    );
  }
  if (resolved.token === undefined) return missingLogin(`auth google ${action}`, args.json);
  const endpoint =
    `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(target.org)}` +
    `/apps/${encodeURIComponent(target.app)}/envs/${encodeURIComponent(target.env)}` +
    '/auth/google-workload-identity';
  try {
    if (action === 'doctor') {
      const response = await serviceJson<GoogleDoctorResponse>(
        `${endpoint}/doctor`,
        resolved.token,
        { method: 'POST' },
      );
      if (args.json) printJsonOk(response);
      else {
        for (const check of response.checks) {
          const target = [check.connectorId, check.operation].filter(Boolean).join('.');
          console.log(
            `${check.ok ? 'PASS' : 'FAIL'} ${check.authKind ?? 'service credential'}: ${target}` +
              (check.reason === undefined ? '' : ` (${check.reason})`),
          );
          if (check.fix !== undefined) console.log(`  Fix: ${check.fix}`);
        }
        if (response.checks.length === 0) {
          console.log('PASS Google workload identity: no compiled Google bindings');
        }
      }
      return response.ok ? 0 : 1;
    }
    const response = await serviceJson<GoogleIdentityResponse>(endpoint, resolved.token, {
      method: action === 'prepare' ? 'PUT' : action === 'revoke' ? 'DELETE' : 'GET',
    });
    if (args.json) {
      printJsonOk(response.data);
      return response.data.status === 'active' || action === 'revoke' ? 0 : 1;
    }
    if (action === 'prepare') {
      printPreparation(response.data, target, {
        projectNumber: args.projectNumber as string,
        pool: args.pool as string,
        provider: args.provider as string,
        ...(args.serviceAccount === undefined ? {} : { serviceAccount: args.serviceAccount }),
      });
    } else {
      console.log(`Google workload identity: ${response.data.status}`);
      console.log(`Subject: ${response.data.subject}`);
      if (action === 'revoke') {
        console.log(
          'Noodle stops issuing or reusing Google credentials immediately. An already-issued Google token can remain valid until its short expiry; remove the customer-side IAM binding as defense in depth.',
        );
      }
    }
    return response.data.status === 'active' || action === 'revoke' ? 0 : 1;
  } catch (error) {
    return printCliFailure(
      `auth google ${action}`,
      serviceFailure(`auth google ${action}`, error, `noodle auth google ${action}`),
      args.json,
    );
  }
}

function printPreparation(
  identity: GoogleIdentityResponse['data'],
  tenant: { readonly org: string; readonly app: string; readonly env: string },
  google: {
    readonly projectNumber: string;
    readonly pool: string;
    readonly provider: string;
    readonly serviceAccount?: string;
  },
): void {
  const providerResource =
    `projects/${google.projectNumber}/locations/global/workloadIdentityPools/${google.pool}` +
    `/providers/${google.provider}`;
  const principal =
    `principal://iam.googleapis.com/projects/${google.projectNumber}/locations/global/` +
    `workloadIdentityPools/${google.pool}/subject/${identity.subject}`;
  console.log('Google workload identity prepared. No service-account key is used or stored.');
  console.log('');
  console.log('1. Enable Google federation APIs:');
  console.log(
    'gcloud services enable iam.googleapis.com cloudresourcemanager.googleapis.com ' +
      `iamcredentials.googleapis.com sts.googleapis.com --project ${google.projectNumber}`,
  );
  console.log('');
  console.log('2. Create the pool and OIDC provider:');
  console.log(
    `gcloud iam workload-identity-pools create ${google.pool} --location global --project ${google.projectNumber}`,
  );
  console.log(
    `gcloud iam workload-identity-pools providers create-oidc ${google.provider} ` +
      `--location global --workload-identity-pool ${google.pool} ` +
      `--project ${google.projectNumber} --issuer-uri ${identity.issuer} ` +
      '--attribute-mapping "google.subject=assertion.sub,attribute.tenant_id=assertion.tenant_id" ' +
      `--attribute-condition "${identity.attributeCondition}"`,
  );
  console.log('');
  console.log('3. Grant only the required Google permissions:');
  if (google.serviceAccount === undefined) {
    console.log(`Federated principal: ${principal}`);
    console.log(
      'Grant this principal the least-privilege role on the target resource (for BigQuery, prefer a dataset-level read role).',
    );
  } else {
    const serviceAccountProject = google.serviceAccount.match(
      /@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com$/,
    )?.[1] as string;
    console.log(
      `gcloud iam service-accounts add-iam-policy-binding ${google.serviceAccount} ` +
        `--project ${serviceAccountProject} --role roles/iam.workloadIdentityUser ` +
        `--member ${principal}`,
    );
    console.log(
      `noodle variables set GOOGLE_SERVICE_ACCOUNT --value ${google.serviceAccount} ` +
        `--runtime cloud --org ${tenant.org} --app ${tenant.app} --env ${tenant.env}`,
    );
  }
  console.log('');
  console.log('4. Configure the deployed environment and validate:');
  console.log(
    `noodle variables set GOOGLE_WIF_PROVIDER --value ${providerResource} ` +
      `--runtime cloud --org ${tenant.org} --app ${tenant.app} --env ${tenant.env}`,
  );
  console.log(
    `noodle auth google status --org ${tenant.org} --app ${tenant.app} --env ${tenant.env}`,
  );
  console.log(
    `noodle auth google doctor --org ${tenant.org} --app ${tenant.app} --env ${tenant.env}`,
  );
}

function validateGoogleSetupArgs(args: GoogleAuthArgs): string | undefined {
  if (!/^[0-9]{6,32}$/.test(args.projectNumber ?? '')) {
    return '--project-number must be the numeric Google Cloud project number.';
  }
  for (const [flag, value] of [
    ['--pool', args.pool],
    ['--provider', args.provider],
  ] as const) {
    if (!/^[a-z][a-z0-9-]{2,30}[a-z0-9]$/.test(value ?? '')) {
      return `${flag} must be a 4-32 character lowercase Google resource id.`;
    }
  }
  if (
    args.serviceAccount !== undefined &&
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/.test(
      args.serviceAccount,
    )
  ) {
    return '--service-account must be a canonical Google service-account email.';
  }
  return undefined;
}

function parseGoogleArgs(rest: readonly string[]): GoogleAuthArgs {
  let org: string | undefined;
  let app: string | undefined;
  let targetEnv: string | undefined;
  let service: string | undefined;
  let authToken: string | undefined;
  let projectNumber: string | undefined;
  let pool: string | undefined;
  let provider: string | undefined;
  let serviceAccount: string | undefined;
  let json = false;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === '--org') org = rest[++index];
    else if (arg === '--app') app = rest[++index];
    else if (arg === '--env') targetEnv = rest[++index];
    else if (arg === '--service') service = rest[++index];
    else if (arg === '--auth-token') authToken = rest[++index];
    else if (arg === '--project-number') projectNumber = rest[++index];
    else if (arg === '--pool') pool = rest[++index];
    else if (arg === '--provider') provider = rest[++index];
    else if (arg === '--service-account') serviceAccount = rest[++index];
    else if (arg === '--json') json = true;
  }
  return {
    ...(org === undefined ? {} : { org }),
    ...(app === undefined ? {} : { app }),
    ...(targetEnv === undefined ? {} : { targetEnv }),
    ...(service === undefined ? {} : { service }),
    ...(authToken === undefined ? {} : { authToken }),
    ...(projectNumber === undefined ? {} : { projectNumber }),
    ...(pool === undefined ? {} : { pool }),
    ...(provider === undefined ? {} : { provider }),
    ...(serviceAccount === undefined ? {} : { serviceAccount }),
    json,
  };
}

function printUsage(): void {
  console.error(
    'usage: noodle auth google prepare --project-number <number> --pool <id> --provider <id> [--service-account <email>] [--org <org> --app <app> --env <env>]',
  );
  console.error(
    '       noodle auth google status|doctor|revoke [--org <org> --app <app> --env <env>] [--json]',
  );
}

function googleUsageFailure(
  json: boolean,
  code: string,
  message: string,
  includeUsage = true,
  printMessage = true,
): number {
  if (json) {
    return printJsonFailure(
      {
        code,
        message,
        fix: 'Pass the required Google workload identity action and flags.',
        next: 'noodle auth google --help',
      },
      EXIT.USAGE,
    );
  }
  if (printMessage) console.error(message);
  if (includeUsage) printUsage();
  return EXIT.USAGE;
}
