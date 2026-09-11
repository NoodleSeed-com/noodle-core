import {
  MIXED_CUSTOMER_AUTH_FEATURE_VERSION,
  type ServiceInfoResponse,
  serviceInfoResponseSchema,
} from '@noodle-borg/wire-contracts';
/**
 * Deployed-version visibility (ADR 0080). The image build injects the source commit + build timestamp as
 * env vars (`NOODLE_BUILD_*`); the service surfaces them at `GET /v1/service/info` and logs them on boot so
 * an operator (and the post-deploy smoke gate) can confirm exactly which commit is live — without opening
 * the Cloud Run console. These fields are deliberately non-sensitive: a commit SHA, a build time, and a
 * version string only. Never add config, secrets, env, or local paths here.
 */
export interface BuildInfo {
  /** Service version string (semver-ish), or `dev` when unset. */
  readonly version: string;
  /** Source commit the running image was built from, or `unknown` when not injected. */
  readonly gitSha: string;
  /** UTC ISO build timestamp, or `unknown` when not injected. */
  readonly buildTime: string;
  /** Unified compatibility-set release, e.g. `r142`, when promoted through the system pipeline. */
  readonly systemRelease?: string;
  /** Checksum of the immutable system release manifest. */
  readonly manifestChecksum?: string;
  /** Exact public package versions admitted by this System Release. */
  readonly packageVersions?: Readonly<Record<string, string>>;
  /** Current and immediately previous versions admitted during an ordered release transition. */
  readonly compatiblePackageVersions?: Readonly<Record<string, readonly string[]>>;
}

export function serviceInfoPayload(
  buildInfo: BuildInfo,
  developerMcp: boolean,
): ServiceInfoResponse {
  return serviceInfoResponseSchema.parse({
    ok: true,
    status: 'ok',
    ...buildInfo,
    features: { mixedCustomerAuth: MIXED_CUSTOMER_AUTH_FEATURE_VERSION },
    ...(developerMcp
      ? { developerPlugin: { mcpCapabilityVersion: DEVELOPER_MCP_CAPABILITY_VERSION } }
      : {}),
  });
}

export function cliCompatibilityError(
  buildInfo: BuildInfo,
  cliVersion: string | readonly string[] | undefined,
): Record<string, unknown> | undefined {
  const supported = buildInfo.compatiblePackageVersions?.['@noodleseed/one'];
  if (typeof cliVersion !== 'string' || supported === undefined || supported.includes(cliVersion)) {
    return undefined;
  }
  const current = buildInfo.packageVersions?.['@noodleseed/one'] ?? supported.at(-1);
  return {
    ok: false,
    code: 'client_version_unsupported',
    error: `Noodle CLI ${cliVersion} is not compatible with this service; install @noodleseed/one@${current}`,
    installedVersion: cliVersion,
    supportedVersion: current,
  };
}

/**
 * Resolve {@link BuildInfo} from the process environment. Defaults are intentionally explicit (`dev` /
 * `unknown`) so a local or un-stamped image is obviously distinguishable from a real release.
 */
export function resolveBuildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  let packageVersions: Readonly<Record<string, string>> | undefined;
  let compatiblePackageVersions: Readonly<Record<string, readonly string[]>> | undefined;
  if (env.NOODLE_PACKAGE_VERSIONS_B64) {
    try {
      const parsed: unknown = JSON.parse(
        Buffer.from(env.NOODLE_PACKAGE_VERSIONS_B64, 'base64').toString('utf8'),
      );
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        Object.values(parsed).every((value) => typeof value === 'string')
      ) {
        packageVersions = parsed as Readonly<Record<string, string>>;
      }
    } catch {
      // Invalid operator metadata is omitted rather than exposing or crashing on arbitrary env input.
    }
  }
  if (env.NOODLE_COMPATIBLE_PACKAGE_VERSIONS_B64) {
    try {
      const parsed: unknown = JSON.parse(
        Buffer.from(env.NOODLE_COMPATIBLE_PACKAGE_VERSIONS_B64, 'base64').toString('utf8'),
      );
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        Object.values(parsed).every(
          (value) => Array.isArray(value) && value.every((entry) => typeof entry === 'string'),
        )
      ) {
        compatiblePackageVersions = parsed as Readonly<Record<string, readonly string[]>>;
      }
    } catch {
      // Invalid operator metadata is omitted rather than exposing or crashing on arbitrary env input.
    }
  }
  return {
    version: env.NOODLE_BUILD_VERSION ?? 'dev',
    gitSha: env.NOODLE_BUILD_SHA ?? 'unknown',
    buildTime: env.NOODLE_BUILD_TIME ?? 'unknown',
    ...(env.NOODLE_SYSTEM_RELEASE ? { systemRelease: env.NOODLE_SYSTEM_RELEASE } : {}),
    ...(env.NOODLE_RELEASE_MANIFEST_CHECKSUM
      ? { manifestChecksum: env.NOODLE_RELEASE_MANIFEST_CHECKSUM }
      : {}),
    ...(packageVersions ? { packageVersions } : {}),
    ...(compatiblePackageVersions ? { compatiblePackageVersions } : {}),
  };
}

import { DEVELOPER_MCP_CAPABILITY_VERSION } from '@noodle-borg/developer-mcp';
