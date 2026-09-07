import type { PackagedAssetReference } from '@noodle-borg/compiler';

export interface DistributionImageSource {
  readonly source: PackagedAssetReference;
  readonly alt: string;
}

export interface DistributionScreenshotSource extends DistributionImageSource {
  /** Host-review prompt that produces this exact MCP App screenshot. */
  readonly prompt?: string;
}

interface DistributionReviewScenarioSourceBase {
  readonly id: string;
  readonly prompt: string;
  readonly expected: string;
}

export interface DistributionPositiveReviewScenarioSource
  extends DistributionReviewScenarioSourceBase {
  readonly shouldInvoke: true;
  /** Exact MCP tools expected during this positive review scenario. */
  readonly tools?: readonly string[];
}

export interface DistributionNegativeReviewScenarioSource
  extends DistributionReviewScenarioSourceBase {
  readonly shouldInvoke: false;
  readonly tools?: never;
}

export type DistributionReviewScenarioSource =
  | DistributionPositiveReviewScenarioSource
  | DistributionNegativeReviewScenarioSource;

/** Host-neutral facts that cannot be derived safely from the compiled MCP and product-skill surface. */
export interface DistributionMetadataSource {
  readonly listing: {
    readonly summary: string;
    readonly description: string;
    readonly keywords?: readonly string[];
  };
  readonly publisher: {
    readonly name: string;
    readonly websiteUrl: string;
  };
  readonly support: {
    readonly documentationUrl: string;
    readonly supportUrl: string;
  };
  readonly legal: {
    readonly privacyPolicyUrl: string;
    readonly termsOfServiceUrl?: string;
  };
  readonly assets: {
    readonly icon: DistributionImageSource;
    readonly logo?: DistributionImageSource;
    readonly screenshots?: readonly DistributionScreenshotSource[];
  };
  readonly review: {
    /** Credential-free reviewer setup. Any actual test credential stays outside source control. */
    readonly instructions: string;
    readonly scenarios: readonly DistributionReviewScenarioSource[];
  };
}

export interface DistributionMetadataV1 extends DistributionMetadataSource {
  readonly schemaVersion: 1;
}

export function projectDistributionMetadata(
  source: DistributionMetadataSource | undefined,
): DistributionMetadataV1 | undefined {
  if (source === undefined) return undefined;
  const cloned = structuredClone(source);
  return { ...cloned, schemaVersion: 1 };
}
