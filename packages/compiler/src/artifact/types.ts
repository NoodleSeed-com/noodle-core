import type { CapabilityRequirementName } from '@noodle-borg/capabilities';
import type { CompiledKnowledgeComponent } from '@noodle-borg/knowledge/portable';
import type { ArtifactVariableDeclaration } from '../business-variables.js';
import type { CustomerEndpointPolicy } from '../customer-endpoint.js';
import type { ManagedCollectionControls } from '../managed-collection-controls.js';
import type { CondNode, ExprNode } from '../manifest/expression.js';
import type { Manifest } from '../manifest/schema.js';
import type { OperationRef } from './operation-ref.js';

export type {
  OperationRef,
  ResolvedCredentialBinding,
  ResolvedOperationRef,
  UnresolvedOperationRef,
} from './operation-ref.js';
export { ARTIFACT_SCHEMA_VERSION, MCP_APP_MIME_TYPE } from './version.js';

/** A JSON Schema 2020-12 document, passed through from the manifest verbatim. */
export type JsonSchema = Record<string, unknown>;

/** A map of field name to parsed value expression (used by `args`, `map`, and `output`). */
export type ExprMap = Readonly<Record<string, ExprNode>>;

/**
 * A single fulfilment step (docs/SPEC.md "Fulfilment Execution"). Discriminated on `kind`; the union
 * is designed to admit a future `compute` step (sandboxed code, docs/decisions/0004) additively.
 * `elicit` is the portable user-input boundary: its schema is restricted to the stable MCP form subset
 * so every adapter can render and validate the same request.
 */
export type ArtifactStep =
  | {
      readonly id: string;
      readonly kind: 'operation';
      /** Parsed boolean condition; the step is skipped when it evaluates false. */
      readonly if?: CondNode;
      readonly operationRef: OperationRef;
      readonly args: ExprMap;
    }
  | {
      readonly id: string;
      readonly kind: 'elicit';
      readonly if?: CondNode;
      readonly message: string;
      /** Normalized stable MCP form schema (flat object of non-sensitive primitive fields). */
      readonly requestedSchema: JsonSchema;
    }
  | {
      readonly id: string;
      readonly kind: 'map';
      readonly if?: CondNode;
      readonly value: ExprMap;
    };

/**
 * Normalized fulfilment for a tool. `operation` is the single-connector-call sugar; `flow` is an
 * ordered list of steps with a final output mapping. Each operation (step or single-op) carries its
 * own {@link OperationRef}, so a `shape-only` artifact leaves them `resolved: false`.
 */
export type ArtifactFulfilment =
  | { readonly kind: 'operation'; readonly operationRef: OperationRef; readonly args: ExprMap }
  | { readonly kind: 'flow'; readonly steps: readonly ArtifactStep[]; readonly output: ExprMap };

/**
 * MCP Apps `_meta.ui` metadata (SEP-1865 / [ADR 0022]). On a **tool**, `resourceUri` links it to its UI
 * widget (`ui://…`). On a **UI resource**, `csp`/`permissions` are the host-enforced capability metadata
 * (the host iframe sandbox enforces them; our runtime only emits them), and `prefersBorder` asks hosts
 * whether to provide an outer visual frame. Fields are independently optional.
 */
export interface WidgetUiMeta {
  readonly resourceUri?: string;
  readonly csp?: {
    readonly connectDomains?: readonly string[] | undefined;
    readonly resourceDomains?: readonly string[] | undefined;
    readonly frameDomains?: readonly string[] | undefined;
  };
  /** Dedicated widget origin (host-dependent; ChatGPT requires one per app for submission). */
  readonly domain?: string;
  readonly permissions?: WidgetPermissions;
  readonly prefersBorder?: boolean;
  /**
   * Tool-surface visibility (`['model', 'app']` by default). `['app']` = a UI-only helper tool:
   * discoverable with app-only metadata so hosts can hide it from the model while allowing widget
   * `callServerTool` calls. Lives on a **tool**'s `_meta.ui`, alongside `resourceUri`.
   */
  readonly visibility?: readonly ('model' | 'app')[];
}

type WidgetPermissionGrant = Readonly<Record<string, never>>;

interface WidgetPermissions {
  readonly camera?: WidgetPermissionGrant;
  readonly microphone?: WidgetPermissionGrant;
  readonly geolocation?: WidgetPermissionGrant;
  readonly clipboardWrite?: WidgetPermissionGrant;
}

/**
 * The MCP `_meta` extension bag, emitted verbatim onto a tool/resource wire descriptor. Open by design
 * (`_meta` is the spec's extension point); the typed `ui` member carries MCP Apps widget metadata.
 */
export interface ArtifactMeta {
  readonly ui?: WidgetUiMeta;
  readonly [key: string]: unknown;
}

export interface ArtifactToolAuthorization {
  /** Public descriptor discovery does not grant execution permission. */
  readonly discovery?: 'public';
  /** Every scope must be present on the verified caller. */
  readonly requiredScopes?: readonly string[];
  /** At least one role must be present on the verified caller. */
  readonly allowedRoles?: readonly string[];
}

export interface ArtifactTool {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly authorization?: ArtifactToolAuthorization;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly annotations?: Record<string, unknown>;
  readonly contextProvider?: true;
  readonly fulfilment: ArtifactFulfilment;
  /** MCP `_meta` (e.g. MCP Apps `{ ui: { resourceUri } }` linking the tool to its widget). */
  readonly _meta?: ArtifactMeta;
}

/**
 * A resolved resource. Carries the same normalized {@link ArtifactFulfilment} as a tool. `isTemplate`
 * records whether `uri` is a `{var}` URI template (then `variables` lists its names, which become the
 * fulfilment's `input` scope); a fixed resource has `isTemplate: false` and no `variables`.
 */
export interface ArtifactResource {
  readonly name: string;
  readonly uri: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly isTemplate: boolean;
  readonly variables?: readonly string[];
  readonly fulfilment: ArtifactFulfilment;
  /** MCP `_meta` (e.g. a widget UI resource's `{ ui: { csp, permissions } }` capability metadata). */
  readonly _meta?: ArtifactMeta;
}

/** A prompt argument descriptor (emitted to `prompts/list`). */
export interface ArtifactPromptArgument {
  readonly name: string;
  readonly description?: string;
  readonly required?: boolean;
}

/**
 * A resolved prompt. Carries the same normalized {@link ArtifactFulfilment} as a tool; its `input` scope
 * is the supplied `arguments` map, and its output maps to prompt messages in the protocol layer.
 */
export interface ArtifactPrompt {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly arguments?: readonly ArtifactPromptArgument[];
  readonly fulfilment: ArtifactFulfilment;
}

export type ArtifactStateHandleKind =
  | 'session'
  | 'draft'
  | 'selection'
  | 'search'
  | 'cart'
  | 'workflow';
export type ArtifactStateHandleScope = 'deployment' | 'caller';

export interface ArtifactStateHandle {
  readonly kind: ArtifactStateHandleKind;
  readonly schema: JsonSchema;
  readonly version: string;
  readonly scope: ArtifactStateHandleScope;
  readonly ttlSeconds?: number;
  readonly claimOnAuthentication?: true;
}

export interface ArtifactState {
  readonly handles: Readonly<Record<string, ArtifactStateHandle>>;
}

export interface ArtifactServerContext {
  readonly defaults?: {
    readonly locale?: string | undefined;
    readonly timeZone?: string | undefined;
  };
  readonly ambient?: {
    readonly outputSchema: JsonSchema;
    readonly fulfilment: ArtifactFulfilment;
  };
}

export interface ArtifactManagedCollection extends ManagedCollectionControls {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly schemaVersion: number;
  readonly schemaDigest: string;
  readonly recordSchema: JsonSchema;
  readonly behavior?: { readonly kind: 'request' };
  readonly source:
    | { readonly authority: 'native' }
    | {
        readonly authority: 'external';
        readonly connectorAlias: string;
        readonly connectorId: string;
        readonly connectorVersion: string;
        readonly scan: OperationRef;
      };
}

interface ArtifactOidcAuth {
  readonly kind?: 'oidc' | undefined;
  readonly issuer: string;
  readonly audience: string;
  readonly claims?: ArtifactAuthClaimMap | undefined;
  readonly routing?: ArtifactCustomerAuthRouting | undefined;
}

interface ArtifactFederatedOidcAuth {
  readonly kind: 'federatedOidc';
  readonly issuers: readonly {
    readonly issuer: string;
    readonly audience: string;
    readonly claims?: ArtifactAuthClaimMap | undefined;
    readonly routing?: ArtifactCustomerAuthRouting | undefined;
  }[];
}

export interface ArtifactCustomerAuthRouting {
  readonly endpoints: Readonly<
    Record<
      string,
      {
        readonly claim: string;
      }
    >
  >;
}

interface ArtifactBridgeAuth {
  readonly kind: 'bridge';
  readonly provider: string;
  readonly verifyUrl?: string | undefined;
  readonly authorizeUrl?: string | undefined;
  readonly projectId?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly authDomain?: string | undefined;
  readonly appId?: string | undefined;
  readonly tenantId?: string | undefined;
  readonly audience?: string | undefined;
  readonly clientId?: string | undefined;
  readonly clientSecret?: string | undefined;
  readonly tokenUrl?: string | undefined;
  readonly scopes?: readonly string[] | undefined;
  readonly authMethod?: 'client_secret_basic' | 'client_secret_post' | undefined;
  readonly user?: ArtifactAuthClaimMap | undefined;
}

type ArtifactAuth = ArtifactOidcAuth | ArtifactFederatedOidcAuth | ArtifactBridgeAuth;

interface ArtifactAuthClaimMap {
  readonly id?: string | undefined;
  readonly email?: string | undefined;
  readonly name?: string | undefined;
  readonly tenant?: string | undefined;
  readonly orgs?: string | undefined;
  readonly roles?: string | undefined;
  readonly scopes?: string | undefined;
}

export interface ArtifactServer {
  readonly name: string;
  readonly version: string;
  readonly title: string;
  /** Optional usage primer returned verbatim in the MCP `initialize` result. */
  readonly instructions?: string;
  readonly context?: ArtifactServerContext;
  readonly interactions?: {
    readonly confirmationFallback: 'host';
  };
  readonly auth?: ArtifactAuth;
  /** Compiled knowledge components (ADR 0202, Core v2): descriptors + generated tool metadata, never bytes. */
  readonly knowledge?: readonly CompiledKnowledgeComponent[];
  /** Compiled managed-record schema intent; lifecycle and operator state remain outside artifacts. */
  readonly managedCollections?: readonly ArtifactManagedCollection[];
  /** Typed reusable managed-variable declarations, never live operator values. */
  readonly variables?: readonly ArtifactVariableDeclaration[];
  readonly assistant?: {
    readonly model: NonNullable<Manifest['server']['assistant']>['model'];
    readonly allowedOrigins: readonly string[];
  } & Omit<NonNullable<Manifest['server']['assistant']>, 'model' | 'allowedOrigins'>;
  readonly branding?: {
    readonly name?: string | undefined;
    readonly accent?: string | undefined;
    readonly surface?: string | undefined;
    readonly surfaceDark?: string | undefined;
    readonly logo?:
      | {
          readonly uri: string;
          readonly darkUri?: string | undefined;
          readonly alt: string;
        }
      | undefined;
    readonly mark?:
      | { readonly uri: string; readonly darkUri?: string | undefined; readonly alt: string }
      | undefined;
    readonly avatar?:
      | { readonly uri: string; readonly darkUri?: string | undefined; readonly alt: string }
      | undefined;
    readonly theme?:
      | {
          readonly light?: ArtifactBrandTheme | undefined;
          readonly dark?: ArtifactBrandTheme | undefined;
        }
      | undefined;
    readonly radius?: 'none' | 'sm' | 'md' | 'lg' | undefined;
    readonly density?: 'compact' | 'comfortable' | undefined;
    readonly typography?: 'system' | 'serif' | 'mono' | undefined;
    readonly colorScheme?: 'auto' | 'light' | 'dark' | undefined;
  };
  readonly shell?: {
    readonly displayMode?: 'compact' | 'comfortable' | 'immersive' | undefined;
    readonly header?:
      | {
          readonly title?: string | undefined;
          readonly subtitle?: string | undefined;
        }
      | undefined;
    readonly navigation?:
      | {
          readonly variant: 'tabs' | 'side' | 'bottom';
          readonly items: readonly {
            readonly id: string;
            readonly label: string;
            readonly view: string;
          }[];
        }
      | undefined;
    readonly persistentActions?:
      | readonly {
          readonly id: string;
          readonly label: string;
          readonly action: string;
        }[]
      | undefined;
  };
  readonly handoff?: {
    readonly allowedDomains: readonly string[];
  };
  readonly state?: ArtifactState;
}

interface ArtifactBrandTheme {
  readonly surface?: string | undefined;
  readonly surfaceRaised?: string | undefined;
  readonly surfaceMuted?: string | undefined;
  readonly text?: string | undefined;
  readonly textMuted?: string | undefined;
  readonly accent?: string | undefined;
  readonly accentText?: string | undefined;
  readonly link?: string | undefined;
  readonly border?: string | undefined;
  readonly borderStrong?: string | undefined;
  readonly focus?: string | undefined;
  readonly success?: string | undefined;
  readonly warning?: string | undefined;
  readonly danger?: string | undefined;
  readonly code?: string | undefined;
}

interface ArtifactSource {
  readonly manifestName: string;
  /** Application version retained for artifact compatibility. */
  readonly manifestVersion: string;
  /** Core manifest language version that produced this internal artifact. */
  readonly coreVersion?: '1' | '2';
}

interface ArtifactCapabilities {
  readonly tools: readonly string[];
  readonly resources?: readonly string[];
  readonly prompts?: readonly string[];
}

interface ArtifactRequirements {
  readonly capabilities?: readonly CapabilityRequirementName[];
}

export type ArtifactConnectionSource =
  | { readonly kind: 'externalExchange' }
  | {
      readonly kind: 'managedSecret';
      readonly secret: string;
      readonly scopes?: readonly string[];
      readonly audience?: string;
    }
  | {
      readonly kind: 'clientCredentials';
      readonly tokenUrl: string;
      readonly clientId: string;
      readonly clientSecret: string;
      readonly scopes?: readonly string[];
      readonly audience?: string;
      readonly authMethod?: 'client_secret_basic' | 'client_secret_post';
    }
  | {
      readonly kind: 'googleWorkloadIdentity';
      readonly provider: string;
      readonly access:
        | { readonly kind: 'direct' }
        | {
            readonly kind: 'serviceAccountImpersonation';
            readonly serviceAccount: string;
          };
    };

export interface ArtifactConnectorBinding {
  readonly profile: string;
  readonly connection: {
    readonly id: string;
    readonly source: ArtifactConnectionSource;
  };
}

export interface ArtifactPackagedAsset {
  readonly logicalId: string;
  readonly sourcePath: string;
  readonly contentHash: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly publicUrl: string;
  readonly objectKey?: string;
}

/**
 * Normalized compiler output loaded by the execution plane.
 *
 * `resolution` records how far compilation got. `$use` schema references are resolved in BOTH
 * cases (it is catalog-independent normalization):
 * - `shape-only` — static shape validated and normalized and `$use` resolved, but connector
 *   resolution has not run. Every `operationRef.resolved` is `false`. A runtime must refuse to serve it.
 * - `resolved` — additionally, every connector alias was resolved against the catalog and every
 *   `operationRef` carries its connector id, version, and signature hash (docs/SPEC.md "Runtime
 *   Invariants").
 */
export interface RuntimeArtifact {
  readonly artifactSchemaVersion: string;
  readonly resolution: 'shape-only' | 'resolved';
  readonly source: ArtifactSource;
  readonly server: ArtifactServer;
  readonly tools: readonly ArtifactTool[];
  readonly resources?: readonly ArtifactResource[];
  readonly prompts?: readonly ArtifactPrompt[];
  readonly assets?: readonly ArtifactPackagedAsset[];
  readonly capabilities: ArtifactCapabilities;
  readonly requirements?: ArtifactRequirements;
  /** Core-v2 credential bindings keyed by the stable `server.use` connector alias. */
  readonly connectorBindings?: Readonly<Record<string, ArtifactConnectorBinding>>;
  /** Customer endpoint declarations keyed by auth-routing name; never contains a resolved URL. */
  readonly customerEndpoints?: Readonly<Record<string, CustomerEndpointPolicy>>;
  readonly config?: {
    readonly variables?: readonly string[];
  };
}
