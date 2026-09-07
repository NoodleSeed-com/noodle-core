import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AdmissionEnvelope, DailyCounterStore } from '@noodle-borg/admission-limits/portable';
import type { ManagedAssistantModelResolver } from '@noodle-borg/assistant-gateway/model-runtime';
import type {
  AssistantAppearanceSettingsStore,
  AssistantElevationCoordinator,
  AssistantElevationStore,
  AssistantStore,
  PublicEmbedStore,
} from '@noodle-borg/assistant-gateway/portable';
import type { SigningKeyProvider } from '@noodle-borg/auth';
import type {
  AppPurgeReconciliationOperator,
  ControlPlaneSignupMode,
  DeployAuthGate,
} from '@noodle-borg/control-plane/portable';
import type { KnowledgeServiceStores } from '@noodle-borg/knowledge-operations/portable';
import type {
  AssetStore,
  DeploymentAutomationAuthorizer,
  IntentEventInput,
  IntentEventStore,
  RequestEventInput,
  RequestEventStore,
} from '@noodle-borg/module';
import type { IntentCaptureSettingsStore } from '@noodle-borg/observability';
import type {
  ConfirmationNonceLedger,
  McpProtocolMode,
  RequestStateManager,
} from '@noodle-borg/protocol';
import type { LoadedServiceModule } from '@noodle-borg/service-modules';
import type {
  AdmissionGate,
  Logger,
  OwnerTokenVerifier,
  TlsPosture,
} from '@noodle-borg/transport-http';
import type { JSONWebKeySet } from 'jose';
import type { BuildInfo } from './build-info.js';
import type { BusinessInformationStore } from './business-information/portable.js';
import type { GoogleWorkloadIdentityStore } from './google-workload-identity-store.js';
import type { DeveloperGrantStore } from './oauth/developer-grant.js';
import type { ServicePrincipalRuntime } from './oauth/service-principal-store.js';
import type { AlertRuleStore } from './store/alert-rules.js';
import type { AuditSink } from './store/audit.js';
import type { UserAppLogStore } from './store/user-app-logs.js';
import type { ConfigStore, ControlPlaneStore } from './store.js';
import type { InvitationEmailSender, WelcomeEmailSender } from './welcome-email.js';

export interface ServiceOptions {
  /** Installation-scoped business records and grants. Hosted boot injects the encrypted Postgres store. */
  readonly businessInformationStore?: BusinessInformationStore;
  /** Explicitly disables managed-record routes when the selected persistence profile cannot own them. */
  readonly businessInformationEnabled?: boolean;
  /** Handler/test injection for ADR 0225; {@link serveService} supplies it only from its Postgres pool. */
  readonly appPurgeReconciliationOperator?: AppPurgeReconciliationOperator;
  /** Mount the authenticated, grant-scoped Noodle developer MCP at `/developer/mcp`. */
  readonly developerMcp?: boolean;
  /** Keyless Google WIF lifecycle exposed to authorized environment operators. */
  readonly googleWorkloadIdentity?: {
    readonly issuer: string;
    readonly signer: SigningKeyProvider;
    readonly store: GoogleWorkloadIdentityStore;
  };
  /** Server-side authorization records for grant-bound developer plugin and managed CLI tokens. */
  readonly developerGrantStore?: DeveloperGrantStore;
  /** Platform-owned service-principal lifecycle, ready only after its durable schema is available. */
  readonly servicePrincipalRuntime?: ServicePrincipalRuntime;
  /** Internal origin-wide fact: the co-hosted OAuth machine lifecycle is completely ready. */
  readonly oauthClientCredentialsReady?: boolean;
  /** Embedded-assistant clients and ephemeral sessions. Production injects a durable shared store. */
  readonly assistantStore?: AssistantStore;
  /** Durable environment-scoped renderer appearance overrides. */
  readonly assistantAppearance?: AssistantAppearanceSettingsStore;
  /** Public-surface ports. Omitted means this service serves authenticated embeds only. */
  readonly publicEmbeds?: PublicEmbedStore;
  /** Mid-conversation sign-in (5.6b). Absent means a mixed surface never offers elevation. */
  readonly elevations?: AssistantElevationStore;
  /** Atomic hosted elevation coordinator; absent uses the local/test store fallback. */
  readonly elevationCoordinator?: AssistantElevationCoordinator;
  readonly admissionCounters?: DailyCounterStore;
  /** Overrides the admission envelope; defaults to `ADMISSION_DEFAULTS`. */
  readonly admissionEnvelope?: AdmissionEnvelope;
  /** Injectable OpenAI-compatible fetch for tests and controlled provider adapters. */
  readonly assistantModelFetch?: typeof fetch;
  /** Hosted operator model resolution. Absent keeps `noodleManaged()` unavailable. */
  readonly managedAssistantModelResolver?: ManagedAssistantModelResolver;
  /** Public base URL for the control-plane/service origin. Defaults to the request's Host header. */
  readonly publicBaseUrl?: string;
  /**
   * Public MCP tenant routing through an edge proxy. `publicBaseDomain` combines with each organization's
   * active MCP-subdomain claim for generated URLs, while `edgeToken` + `allowedBaseDomains` control when
   * `X-App-Host` is trusted on inbound data-plane and protected-resource-metadata requests.
   */
  readonly mcpPublicRouting?: {
    readonly publicBaseDomain?: string;
    readonly allowedBaseDomains?: readonly string[];
    readonly edgeToken?: string;
  };
  /** Temporary service-wide MCP rollout gate. It must never vary by app or deployment. */
  readonly mcpProtocolMode?: McpProtocolMode;
  /** Fleet-shared sealed modern request-state manager, injected by service bootstrap. */
  readonly mcpRequestState?: RequestStateManager;
  /** Durable single-use modern confirmation nonce ledger, injected by service bootstrap. */
  readonly mcpConfirmationNonceLedger?: ConfirmationNonceLedger;
  /** Maximum ordinary request body size in bytes. Default 1 MiB. */
  readonly maxBodyBytes?: number;
  /** Maximum deploy request body size in bytes. Default 32 MiB. */
  readonly maxDeployBodyBytes?: number;
  /** Gate for tenant deploy management. Defaults to {@link allowAllGate} (safe only on a loopback bind). */
  readonly deployGate?: DeployAuthGate;
  /**
   * Store for org/member control-plane data. Default: in-memory, useful for localhost tests only.
   * PostgreSQL persistence owns this store and rejects a separately injected control-plane backend.
   */
  readonly controlPlaneStore?: ControlPlaneStore;
  /** Optional transactional welcome-email delivery adapter. Unset means jobs remain queued without I/O. */
  readonly welcomeEmailSender?: WelcomeEmailSender;
  /** Optional invitation-email adapter; the raw invite token is passed only in-memory for delivery. */
  readonly invitationEmailSender?: InvitationEmailSender;
  /** Public console origin used to build invitation acceptance links. */
  readonly invitationConsoleBaseUrl?: string;
  /** Store for managed hierarchical secrets and variables. Default: the registry's config store. */
  readonly configStore?: ConfigStore;
  /** Knowledge stores + sealing codec (ADR 0202). Default: in-memory, identity codec. */
  readonly knowledge?: KnowledgeServiceStores;
  /**
   * Audit/event sink (Phase 0 governance spine). Without PostgreSQL it is the primary system of record and
   * defaults to an in-memory store. With PostgreSQL, {@link serveService} always keeps the transaction-capable
   * Postgres audit module as primary and adds this sink as a best-effort mirror alongside stdout.
   */
  readonly audit?: AuditSink;
  /** Provider-neutral hosted asset store for packaged static assets. */
  readonly assetStore?: AssetStore;
  /** Route-scoped deploy and asset-preflight automation authorization. */
  readonly deploymentAutomation?: DeploymentAutomationAuthorizer;
  /** Public origin/base URL for hosted asset URLs. Production must use an isolated asset origin. */
  readonly assetPublicBaseUrl?: string;
  /** Optional service clock for deterministic tests around time-windowed policy and admission behavior. */
  readonly clock?: () => Date;
  /**
   * Retention window for archived apps (ADR 0117): the opportunistic sweeper hard-deletes an app's
   * deployment records + managed config this many days after it was archived, and restores past the
   * window answer 410 Gone. Default: 30, overridable via `NOODLE_ARCHIVE_RETENTION_DAYS`.
   */
  readonly archiveRetentionDays?: number;
  /** Structured logger for deploy + request lifecycle events. Default: a no-op logger. */
  readonly logger?: Logger;
  /**
   * Deployed-version metadata surfaced at `GET /v1/service/info` (ADR 0080). Default: resolved from
   * `NOODLE_BUILD_*` env via {@link resolveBuildInfo}. Non-sensitive (commit SHA / build time / version).
   */
  readonly buildInfo?: BuildInfo;
  /**
   * In-app HTTPS posture (Slice 28, ADR 0033). Applied to tenant deploy management and threaded to the
   * tenant MCP router. Default: baseline security headers only, no enforcement.
   */
  readonly tls?: TlsPosture;
  /**
   * Readiness check for `GET /readyz` (Cloud Run / k8s startup + readiness probes): resolves `true` when
   * the service can serve — e.g. the durable store is reachable. Default: always ready. `GET /healthz`
   * (liveness) never calls this.
   */
  readonly readinessProbe?: () => Promise<boolean>;
  /**
   * Verify an owner access token for `owner-only` deployments (OA-1). Threaded to the MCP router's
   * front-door. When absent, owner-only endpoints fail closed (`401`).
   */
  readonly verifyOwnerToken?: OwnerTokenVerifier;
  /**
   * Development/test-only escape hatch for customer IdP discovery against loopback HTTP issuers.
   * Production customer IdPs must remain HTTPS and publicly routable.
   */
  readonly customerVerifierAllowInsecureLocalhost?: boolean;
  /**
   * Development/test-only Firebase JWKS injection. Production Firebase verification uses Google's
   * securetoken x509 certificates by default.
   */
  readonly customerVerifierFirebaseJwks?: JSONWebKeySet;
  /** Development/test-only Firebase JWKS URI injection for child-process localhost E2E. */
  readonly customerVerifierFirebaseJwksUri?: string;
  /** Extra request admission hook layered before built-in preview/anonymous limits. */
  readonly admissionGate?: AdmissionGate;
  /**
   * Tenant-safe developer-facing app log store (M3, [ADR 0101](../../../docs/decisions/0101-tenant-safe-user-app-logs.md)).
   * Backs `GET /v1/orgs/{org}/apps/{app}/envs/{env}/logs` and `noodle logs`. Records are tenant-scoped and
   * structurally redacted; emit sites pass only safe scalars. Defaults to an in-memory store in `serveService`.
   */
  readonly userAppLogStore?: UserAppLogStore;
  /**
   * Tenant-facing analytics event store (ADR 0121) — the fourth telemetry stream, separate from platform
   * logs, user-app logs, and audit. Backs the metrics/events read surfaces. `serveService` defaults it to
   * Postgres when persistence is configured, else in-memory.
   */
  readonly requestEventStore?: RequestEventStore;
  /**
   * Synchronous analytics capture hook threaded into the MCP router (ADR 0121). Must be enqueue-only —
   * `serveService` wires it to a bounded `RequestEventBuffer` over {@link requestEventStore}.
   */
  readonly captureRequestEvent?: (event: RequestEventInput) => void;
  /**
   * Default analytics retention window in days for the durable request-event stream (ADR 0121 Stage A;
   * tiered by-plan retention is a later stage). Default 30.
   */
  readonly requestEventRetentionDays?: number;
  /** Private-preview environment settings. An absent setting is always off. */
  readonly intentCaptureSettingsStore?: IntentCaptureSettingsStore;
  /** Separate intent analytics stream; never reused for app logs or request-event payloads. */
  readonly intentEventStore?: IntentEventStore;
  /** Enqueue-only capture hook; `serveService` supplies a bounded write-behind buffer by default. */
  readonly captureIntentEvent?: (event: IntentEventInput) => void;
  /** Exact organizations admitted to the private preview. Empty/absent keeps the feature unavailable. */
  readonly intentCapturePreviewOrgs?: readonly string[];
  /**
   * Analytics alert-rule store (E2, ADR 0130). Backs the tenant `alerts` CRUD/test routes and the
   * periodic evaluator. Default: in-memory in the handler; `serveService` selects Postgres when
   * persistence is configured, else a `dataDir` JSON-file store, else in-memory (mirrors the
   * request-event store selection).
   */
  readonly alertRuleStore?: AlertRuleStore;
  /**
   * Dev/test-only carve-out allowing `http://localhost` / `http://127.0.0.1` / `[::1]` alert
   * webhook targets (mirrors `customerVerifierAllowInsecureLocalhost`). Production leaves this
   * unset: webhooks are https-only and delivery is SSRF-guarded (DNS-pinned public unicast).
   */
  readonly alertWebhookAllowLoopback?: boolean;
  /**
   * The self-hosted authorization server issuer (OA-2) advertised in protected-resource metadata so an
   * MCP client can discover where to authenticate. When unset, the metadata omits `authorization_servers`.
   */
  readonly authServerIssuer?: string;
  /**
   * The self-hosted authorization-server Express sub-app (OA-2). When set, the front-door delegates the AS
   * paths ({@link isAuthServerPath}: `/authorize`, `/token`, `/register`, the AS metadata + JWKS, and the
   * upstream-human callbacks + generic/developer grant consent routes) to it. Built by {@link serveService} from the
   * `oauth` config.
   */
  readonly authServerApp?: (req: IncomingMessage, res: ServerResponse) => void;
  /**
   * Future Noodle Seed Cloud console entrypoint. When set, `GET /` and `HEAD /` are delegated here after
   * health/assets/OAuth/well-known routes and before tenant MCP fallback.
   */
  readonly consoleHandler?: (req: IncomingMessage, res: ServerResponse) => void;
  /** Google OAuth client id advertised to the CLI for browser-based control-plane login. */
  readonly controlPlaneGoogleClientId?: string;
  /** Allowed Google Workspace / email domain advertised to the CLI and enforced by GoogleControlPlaneGate. */
  readonly controlPlaneAllowedEmailDomain?: string;
  /** Control-plane signup admission/provisioning mode. Default: restricted internal alpha semantics. */
  readonly controlPlaneSignupMode?: ControlPlaneSignupMode;
  /** Public-signup denylist domains. Takes effect before domain/allowlist/public admission. */
  readonly deniedSignupDomains?: readonly string[];
  /** Public-signup denylist external/canonical subjects. Applied before domain/allowlist/public admission. */
  readonly deniedSignupSubjects?: readonly string[];
  /** Boot-initialized service modules. Dynamic loading is owned by serveService, never request handlers. */
  readonly loadedModules?: readonly LoadedServiceModule[];
  /** Complete, fail-closed provider configuration. Absent keeps both provider routes disabled. */
}
