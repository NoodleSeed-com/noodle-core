/** Public, compiler-assignable input consumed by the dependency-free product-skill renderer. */
export interface ProductSkillPackageInput {
  readonly schemaVersion: '1';
  readonly app: {
    readonly name: string;
    readonly title: string;
    readonly version: string;
    readonly branding?: ProductSkillPackageBranding | undefined;
  };
  readonly skill: {
    readonly description: string;
    readonly useWhen: readonly string[];
    readonly workflows: readonly ProductSkillWorkflow[];
    readonly boundaries: readonly string[];
    readonly examples: readonly { readonly prompt: string; readonly workflow: string }[];
  };
  readonly surface: ProductSkillSurface;
  readonly provenance: {
    readonly sourceManifestSha256: string;
    readonly mcpSurfaceSha256: string;
    readonly compilerVersion: '1';
  };
}

export interface ProductSkillPackageBrandAsset {
  readonly logicalId: string;
  readonly alt: string;
  readonly darkLogicalId?: string | undefined;
}

export interface ProductSkillPackageBranding {
  readonly name?: string | undefined;
  readonly accent?: string | undefined;
  readonly surface?: string | undefined;
  readonly surfaceDark?: string | undefined;
  readonly logo?: ProductSkillPackageBrandAsset | undefined;
  readonly mark?: ProductSkillPackageBrandAsset | undefined;
  readonly avatar?: ProductSkillPackageBrandAsset | undefined;
  readonly radius?: 'none' | 'sm' | 'md' | 'lg' | undefined;
  readonly density?: 'compact' | 'comfortable' | undefined;
  readonly typography?: 'system' | 'serif' | 'mono' | undefined;
  readonly colorScheme?: 'auto' | 'light' | 'dark' | undefined;
}

export interface ProductSkillWorkflow {
  readonly id: string;
  readonly title: string;
  readonly intent?: string | undefined;
  readonly steps: readonly ProductSkillWorkflowStep[];
}

export interface ProductSkillWorkflowStep {
  readonly capability: { readonly kind: ProductSkillCapabilityKind; readonly name: string };
  readonly guidance?: string | undefined;
  readonly behavior?: ProductSkillToolBehavior | undefined;
}

export type ProductSkillCapabilityKind = 'tool' | 'resource' | 'prompt';

export interface ProductSkillToolBehavior {
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly idempotent: boolean;
  readonly openWorld: boolean;
  readonly confirmationRequired: boolean;
}

export interface ProductSkillSurface {
  readonly auth: {
    readonly required: boolean;
    readonly kind?: 'oidc' | 'federatedOidc' | undefined;
  };
  readonly tools: readonly ProductSkillTool[];
  readonly resources: readonly ProductSkillResource[];
  readonly prompts: readonly ProductSkillPrompt[];
  readonly widgets: readonly ProductSkillWidget[];
}

export interface ProductSkillTool {
  readonly kind: 'tool';
  readonly name: string;
  readonly title?: string | undefined;
  readonly description: string;
  readonly input: ProductSkillSchemaSummary;
  readonly output?: ProductSkillSchemaSummary | undefined;
  readonly behavior: ProductSkillToolBehavior;
  readonly visibility: readonly ('model' | 'app')[];
  readonly authorization?:
    | {
        readonly discovery?: 'public' | undefined;
        readonly requiredScopes?: readonly string[] | undefined;
        readonly allowedRoles?: readonly string[] | undefined;
      }
    | undefined;
  readonly widget?: string | undefined;
}

export interface ProductSkillSchemaSummary {
  readonly type: string;
  readonly fields?:
    | readonly {
        readonly name: string;
        readonly type: string;
        readonly required: boolean;
        readonly description?: string | undefined;
      }[]
    | undefined;
}

export interface ProductSkillResource {
  readonly kind: 'resource';
  readonly name: string;
  readonly uri: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly mimeType?: string | undefined;
}

export interface ProductSkillPrompt {
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

export interface ProductSkillWidget {
  readonly kind: 'widget';
  readonly name: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly tool: string;
}

export interface ProductSkillMarkdown {
  readonly skill: string;
  readonly reference: string;
}

export type ProductSkillRenderTarget = 'codex' | 'claude-code';

export interface RenderedProductSkillFileV1 {
  readonly target: ProductSkillRenderTarget;
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface RenderedProductSkillBundleV1 {
  readonly schemaVersion: 1;
  readonly rendererVersion: string;
  readonly files: readonly RenderedProductSkillFileV1[];
  readonly bundleSha256: string;
}
