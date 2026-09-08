export const names = [
  'service',
  'githubBuilder',
  'website',
  'docs',
  'console',
  'portal',
  'calendarAdapter',
] as const;
export const oldDigests = Object.fromEntries(
  names.map((name, index) => [name, `sha256:${String(index + 1).repeat(64)}`]),
);
export const newDigests = Object.fromEntries(
  names.map((name, index) => [name, `sha256:${(index + 6).toString(16).repeat(64)}`]),
);
export const packageVersions = {
  '@noodleseed/one': '0.34.0',
  '@noodleseed/agent-kit': '0.21.0',
  '@noodleseed/assistant': '1.0.1',
};
const agreementDocument = { url: 'https://example.test/legal/v1', sha256: 'a'.repeat(64) };
const agreementCatalog = JSON.stringify({
  version: 'v1',
  terms: agreementDocument,
  privacy: agreementDocument,
  processing: agreementDocument,
});
export const stripeConfig = {
  mode: 'live',
  portalConfigurationId: 'bpc_live_portal',
  proProductId: 'prod_live_pro',
  proMonthlyPriceId: 'price_live_pro_month',
  proAnnualPriceId: 'price_live_pro_year',
  scaleProductId: 'prod_live_scale',
  scaleMonthlyPriceId: 'price_live_scale_month',
  scaleAnnualPriceId: 'price_live_scale_year',
  overageProductId: 'prod_live_overage',
  overageBlockPriceId: 'price_live_overage',
  overageSettlementEnabled: 'true',
  secretKeySecret: 'noodle-stripe-live-secret-key',
  secretKeyVersion: '1',
  webhookSecretSecret: 'noodle-stripe-live-webhook-secret',
  webhookSecretVersion: '1',
};
export const stripeRuntimeState = {
  stripeMode: stripeConfig.mode,
  stripePortalConfigurationId: stripeConfig.portalConfigurationId,
  stripeProProductId: stripeConfig.proProductId,
  stripeProMonthlyPriceId: stripeConfig.proMonthlyPriceId,
  stripeProAnnualPriceId: stripeConfig.proAnnualPriceId,
  stripeScaleProductId: stripeConfig.scaleProductId,
  stripeScaleMonthlyPriceId: stripeConfig.scaleMonthlyPriceId,
  stripeScaleAnnualPriceId: stripeConfig.scaleAnnualPriceId,
  stripeOverageProductId: stripeConfig.overageProductId,
  stripeOverageBlockPriceId: stripeConfig.overageBlockPriceId,
  stripeOverageSettlementEnabled: stripeConfig.overageSettlementEnabled,
  stripeSecretKeyRef: `${stripeConfig.secretKeySecret}:1`,
  stripeWebhookSecretRef: `${stripeConfig.webhookSecretSecret}:1`,
};

export function manifest() {
  return {
    releaseId: 'r22',
    gitSha: 'a'.repeat(40),
    manifestChecksum: `sha256:${'b'.repeat(64)}`,
    images: newDigests,
    packages: Object.fromEntries(
      Object.entries(packageVersions).map(([name, version]) => [
        name,
        { version, tag: `tag-${version}`, integrity: `sha512-${name}` },
      ]),
    ),
    compatibility: Object.fromEntries(
      Object.entries(packageVersions).map(([name, version]) => [name, [version]]),
    ),
  };
}

export function harness(
  options: {
    activationBillingMode?: 'free_v1' | 'missing';
    activationStripeMode?: 'live' | 'missing';
    backendSignupMode?: 'public' | 'missing';
    consoleSignupMode?: 'public' | 'missing';
    failAt?: string;
    publish?: string[];
    rollbackFailAt?: string;
  } = {},
) {
  const calls: string[] = [];
  const deployments: Array<{
    name: string;
    image: string;
    phase: string;
    stamps: Record<string, string>;
  }> = [];
  const state = Object.fromEntries(
    names.map((name) => [
      name,
      {
        image: `registry/${name}@${oldDigests[name]}`,
        imageDigest: oldDigests[name],
        releaseId: '',
        gitSha: '',
        manifestChecksum: '',
        packageVersions: '',
        compatibleVersions: '',
        ...(name === 'service' ? { serviceCpuThrottling: 'true', serviceMinInstances: '0' } : {}),
        statsigClientKey: name === 'website' ? 'client-previous-key' : '',
        statsigEnvironmentTier: name === 'website' ? 'staging' : '',
        marketingSitePhase: name === 'website' ? 'consolidated' : '',
        websitePortalUrl: '',
        organizationAgreement: '',
        billingEnforcementMode: '',
        controlPlaneSignupMode: name === 'service' ? 'restricted' : '',
        oauthAllowedEmailDomain: name === 'service' ? 'noodleseed.com' : '',
        consoleSignupMode: name === 'console' ? 'restricted' : '',
        consoleAllowedEmailDomain: name === 'console' ? 'noodleseed.com' : '',
        oauthConsoleClientFingerprint: name === 'service' ? `sha256:${'c'.repeat(64)}` : '',
        servicePublicUrl: name === 'service' ? 'https://cloud.example' : '',
        consolePublicUrl: name === 'service' ? 'https://console.example' : '',
        consoleOauthClientFingerprint: name === 'console' ? `sha256:${'c'.repeat(64)}` : '',
        consoleLegacySessionUntil: name === 'console' ? '2099-08-04T00:00:00.000Z' : '',
        consoleSessionGcsBucket: name === 'console' ? 'console-session-prod' : '',
        consoleAuthUrl: name === 'console' ? 'https://console.example' : '',
        consoleServiceUrl: name === 'console' ? 'https://cloud.example' : '',
        consoleAuthSecretRef: name === 'console' ? 'console-auth-secret:4' : '',
        ...Object.fromEntries(Object.keys(stripeRuntimeState).map((field) => [field, ''])),
      },
    ]),
  );
  const npm = new Map<string, string>();
  const pending = new Set(options.publish ?? []);
  for (const name of Object.keys(packageVersions)) {
    if (!pending.has(name)) npm.set(name, `sha512-${name}`);
  }
  const fail = (point: string) => {
    calls.push(point);
    if (options.failAt === point || options.rollbackFailAt === point)
      throw new Error(`injected ${point}`);
  };
  const adapter = {
    websitePortalUrl: 'https://portal.example.test',
    organizationAgreement: agreementCatalog,
    billingEnforcementMode: 'free_v1',
    stripeRuntimeState,
    controlPlaneSignupMode: 'public',
    consoleSignupMode: 'public',
    calls,
    registry: 'registry',
    async verifyBusinessOnboarding() {
      fail('preflight:agreement');
      return this.organizationAgreement;
    },
    async captureState(phase: string) {
      fail(`capture:${phase}`);
      return { components: structuredClone(state) };
    },
    async assertTargetExists(name: string) {
      fail(`target:${name}`);
    },
    async deploy(name: string, image: string, stamps: Record<string, string>, phase: string) {
      fail(`${phase}:${name}`);
      deployments.push({ name, image, phase, stamps: structuredClone(stamps) });
      state[name] = {
        ...state[name],
        image,
        imageDigest: image.slice(image.indexOf('sha256:')),
        ...stamps,
        ...(name === 'service' && phase !== 'rollback'
          ? {
              organizationAgreement: adapter.organizationAgreement,
              serviceCpuThrottling: 'false',
              serviceMinInstances: '1',
            }
          : {}),
        ...(name === 'service' && phase === 'rollback'
          ? { organizationAgreement: state[name].organizationAgreement }
          : {}),
        ...(name === 'website'
          ? { websitePortalUrl: phase === 'activate-signup' ? 'https://portal.example.test' : '' }
          : {}),
        ...(name === 'service' &&
        phase === 'activate-billing' &&
        options.activationBillingMode !== 'missing'
          ? { billingEnforcementMode: 'free_v1' }
          : {}),
        ...(name === 'service' &&
        phase === 'activate-billing' &&
        options.activationStripeMode !== 'missing'
          ? stripeRuntimeState
          : {}),
        ...(name === 'console' &&
        phase === 'activate-signup' &&
        options.consoleSignupMode !== 'missing'
          ? { consoleSignupMode: 'public', consoleAllowedEmailDomain: '' }
          : {}),
        ...(name === 'service' &&
        phase === 'activate-signup' &&
        options.backendSignupMode !== 'missing'
          ? {
              billingEnforcementMode: 'free_v1',
              controlPlaneSignupMode: 'public',
              oauthAllowedEmailDomain: '',
            }
          : {}),
      };
    },
    async smokeService(_manifest: unknown, phase = 'promote') {
      fail(
        phase === 'activate-billing'
          ? 'smoke:billing'
          : phase === 'activate-signup'
            ? 'smoke:signup'
            : 'smoke:service',
      );
    },
    async readServicePackageVersions() {
      fail('compatibility:service');
      return packageVersions;
    },
    async prepareBillingCatalog() {
      return undefined;
    },
    async preflightWorkloadIdentity() {
      fail('preflight:workload-identity');
    },
    async activateBillingCatalog() {},
    async assertBusinessInformationReaderFloor() {
      fail('compatibility:business-information');
    },
    async readAppVersion(name: string) {
      fail(`version:${name}`);
      return { systemRelease: 'r22', manifestChecksum: manifest().manifestChecksum };
    },
    async smokeWebsite() {
      fail('smoke:website');
    },
    async smokeConsole() {
      fail('smoke:console');
    },
    async smokePortal() {
      fail('smoke:portal');
    },
    async npmState(name: string) {
      return npm.has(name)
        ? {
            version: packageVersions[name],
            integrity: npm.get(name),
            latest: packageVersions[name],
          }
        : { version: null, integrity: null, latest: null };
    },
    async publish(entry: { package: string; integrity: string }) {
      fail(`publish:${entry.package}`);
      npm.set(entry.package, entry.integrity);
    },
    async wait() {},
  };
  return { adapter, calls, deployments, state, npm };
}
