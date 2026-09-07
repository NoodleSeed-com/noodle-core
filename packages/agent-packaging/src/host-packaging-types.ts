import type { ProductSkillPackageInput } from './product-skill-types.js';

export interface HostPackageAssetReference {
  readonly kind: 'asset';
  readonly sourcePath: string;
  readonly logicalId: string;
}

export interface HostDistributionImageV1 {
  readonly source: HostPackageAssetReference;
  readonly alt: string;
}

export interface HostDistributionScreenshotV1 extends HostDistributionImageV1 {
  readonly prompt?: string;
}

interface HostDistributionReviewScenarioBaseV1 {
  readonly id: string;
  readonly prompt: string;
  readonly expected: string;
}

export interface HostDistributionPositiveReviewScenarioV1
  extends HostDistributionReviewScenarioBaseV1 {
  readonly shouldInvoke: true;
  /** Exact MCP tools expected during a positive review scenario. */
  readonly tools?: readonly string[];
}

export interface HostDistributionNegativeReviewScenarioV1
  extends HostDistributionReviewScenarioBaseV1 {
  readonly shouldInvoke: false;
  readonly tools?: never;
}

export type HostDistributionReviewScenarioV1 =
  | HostDistributionPositiveReviewScenarioV1
  | HostDistributionNegativeReviewScenarioV1;

/** Host-neutral listing and review facts projected separately from the canonical App Package. */
export interface HostDistributionMetadataV1 {
  readonly schemaVersion: 1;
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
    readonly icon: HostDistributionImageV1;
    readonly logo?: HostDistributionImageV1;
    readonly screenshots?: readonly HostDistributionScreenshotV1[];
  };
  readonly review: {
    readonly instructions: string;
    readonly scenarios: readonly HostDistributionReviewScenarioV1[];
  };
}

export interface HostPackageAssetInput {
  readonly logicalId: string;
  readonly sourcePath: string;
  readonly content: Uint8Array;
}

export interface ResolvedHostPackageImage extends HostPackageAssetInput {
  readonly alt: string;
  readonly prompt?: string;
  readonly mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
}

export interface HostPackageAdapterInput {
  readonly appPackage: ProductSkillPackageInput;
  readonly distribution: HostDistributionMetadataV1;
  readonly mcpServer: {
    readonly url: string;
    readonly transport: 'streamable-http';
  };
  readonly assets: {
    readonly icon: ResolvedHostPackageImage;
    readonly logo?: ResolvedHostPackageImage;
    readonly screenshots: readonly ResolvedHostPackageImage[];
  };
}

export interface HostPackageRequest {
  readonly appPackage: ProductSkillPackageInput;
  readonly distribution: HostDistributionMetadataV1;
  readonly mcpServer: {
    readonly url: string;
    readonly transport: 'streamable-http';
  };
  readonly assets: readonly HostPackageAssetInput[];
}

export type HostPackageFileRole =
  | 'manifest'
  | 'mcp'
  | 'skill'
  | 'branding'
  | 'legal'
  | 'documentation'
  | 'test';

export interface HostPackageFile {
  readonly role: HostPackageFileRole;
  readonly path: string;
  readonly content: string | Uint8Array;
}

export type HostPackageIssueSeverity = 'error' | 'warning';

export interface HostPackageTargetIssue {
  readonly severity: HostPackageIssueSeverity;
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface HostPackageIssue extends HostPackageTargetIssue {
  readonly origin: 'framework' | 'target';
  readonly target: string;
}

export interface HostPackageAdapter {
  readonly target: string;
  readonly version: string;
  validate(input: HostPackageAdapterInput): readonly HostPackageTargetIssue[];
  render(input: HostPackageAdapterInput): readonly HostPackageFile[];
}

export interface RenderedHostPackageFile {
  readonly role: HostPackageFileRole;
  readonly path: string;
  readonly content: Uint8Array;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface HostPackageArchive {
  readonly format: 'zip';
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly byteLength: number;
}

interface HostPackageResultBase {
  readonly target: string;
  readonly adapterVersion: string;
  readonly issues: readonly HostPackageIssue[];
}

export interface HostPackageSuccess extends HostPackageResultBase {
  readonly ok: true;
  readonly files: readonly RenderedHostPackageFile[];
  readonly treeSha256: string;
  readonly archive: HostPackageArchive;
}

export interface HostPackageFailure extends HostPackageResultBase {
  readonly ok: false;
}

export type HostPackageResult = HostPackageSuccess | HostPackageFailure;
