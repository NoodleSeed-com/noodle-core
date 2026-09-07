import type { Server } from 'node:http';
import type { SigningKeyProvider } from '@noodle-borg/auth';
import type {
  ControlPlaneSignupMode,
  GoogleIdTokenVerifier,
} from '@noodle-borg/control-plane/portable';
import type { WrappingMasterKey } from '@noodle-borg/runtime';
import type { ModuleImporter, ModuleInput } from '@noodle-borg/service-modules';
import type { ExternalCredentialExchangeRuntimeOptions } from './external-credential-exchange.js';
import type { LocalDevtoolsDelegatedCredentialSink } from './local-devtools-delegated-credentials.js';
import type { LocalDevtoolsDelegatedExchangeRuntime } from './local-devtools-delegated-exchange.js';
import type { GoogleAuthenticator } from './oauth/google.js';
import type { ServiceOptions } from './options.js';
import type { RecoverResult, ServerRegistry } from './registry.js';
import type { PostgresPool } from './store/cloudsql-pool.js';
import type { ArtifactStore, TenantBridgeAuthConfig } from './store.js';

export type ServeServiceOptions = ServiceOptions & {
  readonly port?: number;
  readonly host?: string;
  /**
   * Loopback-only `noodle dev` seam: verify Firebase ID tokens directly instead of requiring a hosted
   * Noodle bridge token. The service rejects this option on every non-loopback bind.
   */
  readonly localDevtoolsDirectFirebaseAuth?: boolean;
  /**
   * Loopback-only `noodle dev` seam: verify Microsoft ID tokens directly instead of requiring a hosted
   * Noodle bridge token. The service rejects this option on every non-loopback bind.
   */
  readonly localDevtoolsDirectMicrosoftAuth?: boolean;
  /** Loopback-only lazy signing authority for local generic delegated token exchange. */
  readonly localDevtoolsDelegatedExchange?: LocalDevtoolsDelegatedExchangeRuntime;
  /** Resolve managed bridge variables for the single local app before direct token verification. */
  readonly localDevtoolsResolveBridgeAuth?: (
    auth: TenantBridgeAuthConfig,
    resource: string,
  ) => Promise<TenantBridgeAuthConfig>;
  /** Google OAuth client id / OIDC audience for control-plane ID-token verification (MT-2). */
  readonly googleClientId?: string;
  /**
   * Extra accepted OIDC audiences beyond {@link googleClientId} (e.g. the hosted console's Google web
   * OAuth client, ADR 0116). A control-plane ID token verifies when its `aud` matches the primary client
   * OR any of these. Does not change the client id reported by `/v1/service/info`.
   */
  readonly googleAdditionalAudiences?: readonly string[];
  /** Exact immutable Google subjects for CI/build service-account identity tokens. */
  readonly googleWorkloadSubjects?: readonly string[];
  /** Temporary direct-human Google bearer compatibility. Defaults true until the fallback is finalized. */
  readonly googleHumanAuthCompatibility?: boolean;
  /** Canonical principal subjects allowed to manage orgs; email is legacy direct-Google-only compatibility. */
  readonly controlPlaneAdmins?: readonly string[];
  /** Public self-service signup mode. Default preserves internal-alpha restricted admission. */
  readonly controlPlaneSignupMode?: ControlPlaneSignupMode;
  /** Injectable Google verifier for tests; production uses `google-auth-library`. */
  readonly googleVerifier?: GoogleIdTokenVerifier;
  /**
   * Enable durable persistence + restart recovery under this data directory (Slice 25, ADR 0027).
   * When unset (and no Postgres backend is configured), deploys are in-memory only and lost on restart.
   */
  readonly dataDir?: string;
  /**
   * Postgres connection string for the relational {@link ArtifactStore} backend (ADR 0035). When set,
   * Postgres is selected over the file/in-memory backends.
   */
  readonly databaseUrl?: string;
  /**
   * Already-created portable PostgreSQL resource. Managed hosts construct their vendor adapter outside
   * this package; a successful `serveService` call transfers lifecycle ownership to the running service.
   */
  readonly postgresPool?: PostgresPool;
  /**
   * Base64-encoded 32-byte master key that encrypts persisted secrets at rest (Slice 26, ADR 0028).
   * **Required whenever a durable store is enabled** (`dataDir`, `databaseUrl`, or `postgresPool`) unless
   * `wrappingMasterKey` is supplied — the service refuses to boot without a custodian (fail closed).
   */
  readonly secretMasterKey?: string;
  /**
   * Injected wrapping-key custodian for managed hosts. Takes precedence over `secretMasterKey`; vendor
   * construction and credentials remain outside the portable public service.
   */
  readonly wrappingMasterKey?: WrappingMasterKey;
  /**
   * Eagerly recompile every persisted server on boot and report failures, instead of the default lazy
   * recompile-on-first-request (ADR 0036). For a single-instance / on-prem deploy that prefers fail-fast
   * boot validation; leave off on a multi-instance platform (Cloud Run).
   */
  readonly warmAll?: boolean;
  /**
   * Programmatic self-hosted/internal external credential-provider configuration. Provider enrollment,
   * CRUD, and durable hosted lifecycle are intentionally outside this service surface. Its required subject
   * pin port must be durable/shared for hosted or multi-instance production; the exported in-memory store is
   * local/test-only.
   */
  readonly externalCredentialExchange?: ExternalCredentialExchangeRuntimeOptions;
  /**
   * Enable the self-hosted OAuth authorization server (OA-2,
   * [ADR 0042](../../../docs/decisions/0042-self-hosted-oauth-authorization-server.md)). When set, the AS
   * routes are served (DCR + PKCE, federating human login upstream), the issuer is advertised in
   * protected-resource metadata, and owner-only tokens are verified in-process against the signing key.
   * The OAuth state store is the shared Postgres store when persistence is on, else in-memory.
   */
  readonly oauth?: {
    /** The AS issuer — its public origin (e.g. `https://cloud.noodleseed.dev`). HTTPS, no path/query. */
    readonly issuer: string;
    readonly signer: SigningKeyProvider;
    /** Direct Google human federation remains optional during fallback and is removed after finalization. */
    readonly google?: GoogleAuthenticator;
    /** Stable first-party public client used by the hosted Console's server-side PKCE flow. */
    readonly consoleClient?: {
      readonly clientId: string;
      readonly redirectUri: string;
    };
    /** Stable first-party public client used by the Business Portal's server-side PKCE flow. */
    readonly portalClient?: {
      readonly clientId: string;
      readonly redirectUri: string;
    };
    /** Restrict authorizing users to this email domain during alpha (e.g. `@noodleseed.com`). */
    readonly allowedEmailDomain?: string;
    /** Benign retry/concurrency window for a rotated refresh token. Default: provider default. */
    readonly refreshTokenGraceSeconds?: number;
    /** Lost-response recovery window for an unused refresh-token successor. Default: provider default. */
    readonly refreshTokenRecoverySeconds?: number;
    /**
     * The first-party control-plane token exchange (RFC 8693, ADR 0218): the dedicated confidential
     * client the hosted assistant's connector exchanges through, and the exact tenants whose
     * assertions it serves. Absent = the grant type is refused and never advertised.
     */
    readonly controlPlaneExchange?: {
      readonly clientId: string;
      readonly clientSecret: string;
      /** Exact `org/app/env` values, e.g. `noodleseed/site-assistant/prod`. */
      readonly allowedTenants: readonly string[];
    };
  };
  /** Stage-1 external signup domains to seed into the durable allowlist at startup. */
  readonly signupAllowedDomains?: readonly string[];
  /** Stage-1 external signup Google subjects to seed into the durable allowlist at startup. */
  readonly signupAllowedSubjects?: readonly string[];
  /** Public-signup denylist domains. */
  readonly deniedSignupDomains?: readonly string[];
  /** Public-signup denylist subjects. */
  readonly deniedSignupSubjects?: readonly string[];
  /** Operator-selected service modules loaded once at boot. Specs are never tenant/request controlled. */
  readonly modules?: readonly ModuleInput[];
  /** Package allowlist for dynamically imported operator modules. First-party instances bypass import. */
  readonly moduleAllowlist?: readonly string[];
  /**
   * Test/operator injection for dynamic module loading (defaults to `import()`). Lets tests observe
   * which package specs the boot resolves — including the env-gated commercial feedback module —
   * without installing anything.
   */
  readonly moduleImporter?: ModuleImporter;
  /** Directory containing `noodle.service.yaml` / `noodle.service.ts`; defaults to cwd. */
  readonly serviceConfigDir?: string;
  /** Explicitly choose a service config source when both YAML and TypeScript files exist. */
  readonly serviceConfigSource?: 'yaml' | 'typescript';
};

export interface RunningService {
  readonly http: Server;
  readonly url: string;
  readonly port: number;
  /** In-process runtime used by `noodle dev` for direct local deploy and hot reload. */
  readonly registry: ServerRegistry;
  /** Recovery outcome when persistence is enabled; absent otherwise. */
  readonly recovered?: RecoverResult;
  /** Loopback-only direct Firebase/Microsoft Devtools credential sink. */
  readonly localDevtoolsDelegatedCredentials?: LocalDevtoolsDelegatedCredentialSink;
  close(): Promise<void>;
}
