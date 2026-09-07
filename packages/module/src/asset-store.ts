import type { IncomingMessage, ServerResponse } from 'node:http';

export interface AssetScope {
  readonly org: string;
  readonly app: string;
  readonly env: string;
}

export interface PreparedPackagedAsset {
  readonly logicalId: string;
  readonly sourcePath: string;
  readonly absolutePath: string;
  readonly contentHash: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
}

export interface HostedPackagedAsset {
  readonly logicalId: string;
  readonly sourcePath: string;
  readonly contentHash: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly publicUrl: string;
  readonly objectKey: string;
}

export interface AssetUploadTarget {
  readonly logicalId: string;
  readonly objectKey: string;
  readonly uploadUrl: string;
  readonly method: 'PUT';
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: string;
}

export interface AssetUploadPlan {
  readonly assetOrigin: string;
  readonly assets: readonly HostedPackagedAsset[];
  readonly uploads: readonly AssetUploadTarget[];
}

export class AssetPlanError extends Error {
  readonly assetPlanError = true;

  constructor(message: string) {
    super(message);
    this.name = 'AssetPlanError';
  }
}

export interface AssetStore {
  planUploads(input: {
    readonly scope: AssetScope;
    readonly assets: readonly PreparedPackagedAsset[];
    readonly uploadBaseUrl: string;
    readonly publicBaseUrl: string;
    readonly now?: Date;
  }): Promise<AssetUploadPlan>;
  verifyUploadedAssets(input: {
    readonly scope: AssetScope;
    readonly assets: readonly HostedPackagedAsset[];
  }): Promise<
    | { readonly ok: true; readonly assets: readonly HostedPackagedAsset[] }
    | { readonly ok: false; readonly error: string }
  >;
  recordReachability(input: {
    readonly scope: AssetScope;
    readonly deploymentId: string;
    readonly deploymentVersion: number;
    readonly assets: readonly HostedPackagedAsset[];
  }): Promise<void>;
  handleRequest?(req: IncomingMessage, res: ServerResponse, pathname: string): boolean;
}
