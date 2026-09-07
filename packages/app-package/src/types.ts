export type AppPackageCapabilityKind = 'tool' | 'resource' | 'prompt';

export interface AppPackageCapabilityRef {
  readonly kind: AppPackageCapabilityKind;
  readonly name: string;
}

export interface AppPackageBrandAsset {
  readonly logicalId: string;
  readonly alt: string;
  readonly darkLogicalId?: string | undefined;
}

export interface AppPackageBranding {
  readonly name?: string | undefined;
  readonly accent?: string | undefined;
  readonly surface?: string | undefined;
  readonly surfaceDark?: string | undefined;
  readonly logo?: AppPackageBrandAsset | undefined;
  readonly mark?: AppPackageBrandAsset | undefined;
  readonly avatar?: AppPackageBrandAsset | undefined;
  readonly radius?: 'none' | 'sm' | 'md' | 'lg' | undefined;
  readonly density?: 'compact' | 'comfortable' | undefined;
  readonly typography?: 'system' | 'serif' | 'mono' | undefined;
  readonly colorScheme?: 'auto' | 'light' | 'dark' | undefined;
}

export interface AppPackageSchemaField {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly description?: string | undefined;
}

export interface AppPackageSchemaSummary {
  readonly type: string;
  readonly fields?: readonly AppPackageSchemaField[] | undefined;
}

export interface AppPackageTool {
  readonly kind: 'tool';
  readonly name: string;
  readonly title?: string | undefined;
  readonly description: string;
  readonly input: AppPackageSchemaSummary;
  readonly output?: AppPackageSchemaSummary | undefined;
  readonly behavior: {
    readonly readOnly: boolean;
    readonly destructive: boolean;
    readonly idempotent: boolean;
    readonly openWorld: boolean;
    readonly confirmationRequired: boolean;
  };
  readonly visibility: readonly ('model' | 'app')[];
  readonly authorization?:
    | {
        readonly requiredScopes?: readonly string[] | undefined;
        readonly allowedRoles?: readonly string[] | undefined;
      }
    | undefined;
  readonly widget?: string | undefined;
}

export interface AppPackageResource {
  readonly kind: 'resource';
  readonly name: string;
  readonly uri: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly mimeType?: string | undefined;
}
export interface AppPackagePrompt {
  readonly kind: 'prompt';
  readonly name: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly arguments: readonly {
    readonly name: string;
    readonly description?: string | undefined;
    readonly required: boolean;
  }[];
}
export interface AppPackageWidget {
  readonly kind: 'widget';
  readonly name: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly tool: string;
}

export interface CompiledAgentSkill {
  readonly description: string;
  readonly useWhen: readonly string[];
  readonly workflows: readonly {
    readonly id: string;
    readonly title: string;
    readonly intent?: string | undefined;
    readonly steps: readonly {
      readonly capability: AppPackageCapabilityRef;
      readonly guidance?: string | undefined;
      readonly behavior?: AppPackageTool['behavior'] | undefined;
    }[];
  }[];
  readonly boundaries: readonly string[];
  readonly examples: readonly { readonly prompt: string; readonly workflow: string }[];
}

export interface AppPackageSurface {
  readonly auth: {
    readonly required: boolean;
    readonly kind?: 'oidc' | 'federatedOidc' | undefined;
  };
  readonly tools: readonly AppPackageTool[];
  readonly resources: readonly AppPackageResource[];
  readonly prompts: readonly AppPackagePrompt[];
  readonly widgets: readonly AppPackageWidget[];
}

export interface AppPackageArtifactV1 {
  readonly schemaVersion: '1';
  readonly app: {
    readonly name: string;
    readonly title: string;
    readonly version: string;
    readonly branding?: AppPackageBranding | undefined;
  };
  readonly skill: CompiledAgentSkill;
  readonly surface: AppPackageSurface;
  readonly provenance: {
    readonly sourceManifestSha256: string;
    readonly mcpSurfaceSha256: string;
    readonly compilerVersion: '1';
  };
}
