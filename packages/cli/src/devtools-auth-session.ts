import {
  canonicalScopes,
  McpOAuthClient,
  type McpOAuthClientRegistration,
  type McpOAuthDiscovery,
  type McpOAuthPendingAuthorization,
  type McpOAuthTokens,
  parseBearerChallenge,
} from '@noodle-borg/auth';
import type { LocalDevtoolsDelegatedCredentialSink } from '@noodle-borg/service/local';
import { constantTimeStringEqual, safeFailure } from './devtools-auth-session-helpers.js';
import {
  DevtoolsAuthRequiredError,
  type DevtoolsAuthState,
  type DevtoolsAuthStatus,
  type DevtoolsCustomerAuth,
  type DevtoolsOAuthDriver,
} from './devtools-auth-types.js';
import { storeDevtoolsDelegatedCredential } from './devtools-delegated-credential.js';
import {
  type DevtoolsFirebaseAuthorizationPage,
  type DevtoolsFirebaseCallback,
  type DevtoolsFirebaseDriver,
  type DevtoolsFirebasePendingAuthorization,
  FirebaseDevtoolsAuthDriver,
} from './devtools-firebase-auth.js';
import { MicrosoftDevtoolsAuthDriver, microsoftIssuer } from './devtools-microsoft-auth.js';

export {
  DevtoolsAuthRequiredError,
  type DevtoolsAuthState,
  type DevtoolsAuthStatus,
  type DevtoolsCustomerAuth,
  type DevtoolsOAuthDriver,
} from './devtools-auth-types.js';
export type { DevtoolsFirebaseCallback, DevtoolsFirebaseDriver } from './devtools-firebase-auth.js';

export class DevtoolsAuthSession {
  readonly #resource: string;
  readonly #auth: DevtoolsCustomerAuth;
  readonly #delegatedCredentialSink: LocalDevtoolsDelegatedCredentialSink | undefined;
  readonly #driverFactory?: (issuer: string) => DevtoolsOAuthDriver;
  readonly #firebaseDriver?: DevtoolsFirebaseDriver;
  #driver: DevtoolsOAuthDriver | undefined;
  #selectedIssuer: string | undefined;
  #discovery: McpOAuthDiscovery | undefined;
  #registration: McpOAuthClientRegistration | undefined;
  #pending: McpOAuthPendingAuthorization | undefined;
  #firebasePending: DevtoolsFirebasePendingAuthorization | undefined;
  #tokens: McpOAuthTokens | undefined;
  #requestedScopes: readonly string[] = [];
  #state: DevtoolsAuthState;
  #message: string | undefined;
  #errorCode: string | undefined;
  #generation = 0;
  #refreshing:
    | {
        readonly generation: number;
        readonly promise: Promise<McpOAuthTokens>;
      }
    | undefined;

  constructor(options: {
    readonly resource: string;
    readonly redirectUri: string;
    readonly auth: DevtoolsCustomerAuth;
    /** Focused test seam; production constructs the standards client. */
    readonly driver?: DevtoolsOAuthDriver;
    /** Focused multi-issuer test seam; production constructs one standards client per selected issuer. */
    readonly driverFactory?: (issuer: string) => DevtoolsOAuthDriver;
    /** Focused Firebase test seam; production constructs the local Firebase adapter. */
    readonly firebaseDriver?: DevtoolsFirebaseDriver;
    /** In-process-only bridge into the loopback runtime's ephemeral delegated credential source. */
    readonly delegatedCredentialSink?: LocalDevtoolsDelegatedCredentialSink;
    readonly fetchFn?: typeof fetch;
  }) {
    this.#resource = options.resource;
    this.#auth = options.auth;
    this.#delegatedCredentialSink = options.delegatedCredentialSink;
    this.#state = options.auth.kind === 'unsupported' ? 'unsupported' : 'signed_out';
    if (options.auth.kind === 'firebase') {
      this.#firebaseDriver =
        options.firebaseDriver ??
        new FirebaseDevtoolsAuthDriver({
          auth: options.auth,
          resource: options.resource,
          redirectUri: options.redirectUri,
          ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
        });
    } else if (options.auth.kind === 'microsoft') {
      const microsoftAuth = options.auth;
      const issuer = microsoftIssuer(microsoftAuth.tenantId);
      this.#selectedIssuer = issuer;
      this.#driverFactory =
        options.driverFactory ??
        (() =>
          options.driver ??
          new MicrosoftDevtoolsAuthDriver({
            auth: microsoftAuth,
            resource: options.resource,
            redirectUri: options.redirectUri,
            ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
          }));
      this.#driver = this.#driverFactory(issuer);
    } else if (options.auth.kind !== 'unsupported') {
      const allowInsecureLocalhost = options.auth.allowInsecureLocalhost === true;
      this.#driverFactory =
        options.driverFactory ??
        (options.driver !== undefined
          ? () => options.driver as DevtoolsOAuthDriver
          : (issuer) =>
              new McpOAuthClient({
                resource: options.resource,
                issuer,
                redirectUri: options.redirectUri,
                ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
                ...(allowInsecureLocalhost ? { allowInsecureLocalhost: true } : {}),
              }));
      if (options.auth.kind === 'oidc') {
        this.#selectedIssuer = options.auth.issuer;
        this.#driver = this.#driverFactory(options.auth.issuer);
      }
    }
  }

  status(): DevtoolsAuthStatus {
    if (this.#auth.kind === 'unsupported') {
      return {
        required: true,
        supported: false,
        state: 'unsupported',
        method: this.#auth.method,
        scopes: [],
        message: `${this.#auth.method} sign-in is not supported in Devtools yet`,
      };
    }
    const issuers = this.#configuredIssuers();
    const firebaseIssuer =
      this.#auth.kind === 'firebase'
        ? (this.#auth.authDomain ?? `${this.#auth.projectId}.firebaseapp.com`)
        : undefined;
    return {
      required: true,
      supported: true,
      state: this.#state,
      ...(this.#selectedIssuer !== undefined
        ? { issuer: this.#selectedIssuer }
        : firebaseIssuer === undefined
          ? {}
          : { issuer: firebaseIssuer }),
      ...(this.#auth.kind === 'federatedOidc' ? { issuers } : {}),
      ...(this.#auth.kind === 'firebase' ? { method: 'firebase' } : {}),
      ...(this.#auth.kind === 'microsoft' ? { method: 'microsoft' } : {}),
      scopes: [...this.#visibleScopes()],
      ...(this.#tokens?.expiresAt !== undefined ? { expiresAt: this.#tokens.expiresAt } : {}),
      ...(this.#errorCode !== undefined ? { errorCode: this.#errorCode } : {}),
      ...(this.#message !== undefined ? { message: this.#message } : {}),
    };
  }

  async start(issuer?: string): Promise<string> {
    if (this.#auth.kind === 'firebase') return this.#startFirebase();
    const selectedIssuer = this.#resolveIssuer(issuer);
    const switchingIssuer = selectedIssuer !== this.#selectedIssuer;
    const generation = ++this.#generation;
    this.#refreshing = undefined;
    this.#pending = undefined;
    this.#tokens = undefined;
    this.#clearDelegatedCredential();
    this.#state = 'authorizing';
    this.#message = undefined;
    this.#errorCode = undefined;
    try {
      if (switchingIssuer) {
        this.#selectedIssuer = selectedIssuer;
        this.#driver = undefined;
        this.#discovery = undefined;
        this.#registration = undefined;
      }
      const driver = this.#requiredDriver();
      const discovery = this.#discovery ?? (await driver.discover());
      this.#assertGeneration(generation);
      this.#discovery = discovery;
      if (this.#requestedScopes.length === 0) {
        this.#requestedScopes = discovery.scopes;
      }
      const registration =
        this.#registration ?? (await driver.register(discovery, this.#requestedScopes));
      this.#assertGeneration(generation);
      this.#registration = registration;
      const pending = driver.beginAuthorization(discovery, registration, this.#requestedScopes);
      this.#assertGeneration(generation);
      this.#pending = pending;
      this.#state = 'authorizing';
      this.#message = undefined;
      return pending.authorizationUrl;
    } catch (error) {
      if (this.#generation === generation) {
        this.#state = 'error';
        const failure = safeFailure(error, 'Could not start sign-in');
        this.#message = failure.message;
        this.#errorCode = failure.errorCode;
      }
      throw error;
    }
  }

  async complete(callbackUrl: string): Promise<void> {
    if (this.#auth.kind === 'firebase') {
      throw new DevtoolsAuthRequiredError('Firebase sign-in requires a form POST');
    }
    const driver = this.#requiredDriver();
    if (!this.#discovery || !this.#registration || !this.#pending) {
      throw new DevtoolsAuthRequiredError('No OAuth sign-in is pending');
    }
    const generation = this.#generation;
    const discovery = this.#discovery;
    const registration = this.#registration;
    const pending = this.#pending;
    const callbackState = new URL(callbackUrl).searchParams.get('state') ?? '';
    if (!constantTimeStringEqual(callbackState, pending.state)) {
      throw new DevtoolsAuthRequiredError('OAuth callback does not match the active sign-in');
    }
    this.#pending = undefined;
    try {
      const tokens = await driver.exchangeCallback(discovery, registration, pending, callbackUrl);
      this.#assertGeneration(generation);
      await this.#storeDelegatedCredential(tokens);
      this.#assertGeneration(generation);
      this.#tokens = tokens;
      this.#requestedScopes = canonicalScopes([...this.#requestedScopes, ...tokens.scope]);
      this.#state = 'signed_in';
      this.#message = undefined;
      this.#errorCode = undefined;
    } catch (error) {
      if (this.#generation === generation) {
        this.#state = 'error';
        const failure = safeFailure(error, 'Sign-in failed');
        this.#message = failure.message;
        this.#errorCode = failure.errorCode;
      }
      throw error;
    }
  }

  callbackTransport(): 'query' | 'form_post' {
    return this.#auth.kind === 'firebase' ? 'form_post' : 'query';
  }

  firebaseAuthorizationPage(url: URL): DevtoolsFirebaseAuthorizationPage | undefined {
    if (this.#auth.kind !== 'firebase' || !this.#firebasePending) return undefined;
    return this.#requiredFirebaseDriver().renderAuthorizationPage(url, this.#firebasePending);
  }

  async completeFirebase(callback: DevtoolsFirebaseCallback): Promise<void> {
    if (this.#auth.kind !== 'firebase' || !this.#firebasePending) {
      throw new DevtoolsAuthRequiredError('No Firebase sign-in is pending');
    }
    const pending = this.#firebasePending;
    if (!constantTimeStringEqual(callback.state, pending.state)) {
      throw new DevtoolsAuthRequiredError('Firebase callback does not match the active sign-in');
    }
    const generation = this.#generation;
    this.#firebasePending = undefined;
    try {
      const tokens = await this.#requiredFirebaseDriver().completeAuthorization(pending, callback);
      this.#assertGeneration(generation);
      await this.#storeDelegatedCredential(tokens);
      this.#assertGeneration(generation);
      this.#tokens = tokens;
      this.#state = 'signed_in';
      this.#message = undefined;
      this.#errorCode = undefined;
    } catch (error) {
      if (this.#generation === generation) {
        this.#state = 'error';
        const failure = safeFailure(error, 'Firebase sign-in failed');
        this.#message = failure.message;
        this.#errorCode = failure.errorCode;
      }
      throw error;
    }
  }

  async accessToken(options: { readonly forceRefresh?: boolean } = {}): Promise<string> {
    if (this.#state === 'reauthorization_required') throw new DevtoolsAuthRequiredError();
    if (!this.#tokens) throw new DevtoolsAuthRequiredError();
    const expiring =
      this.#tokens.expiresAt !== undefined && this.#tokens.expiresAt <= Date.now() + 30_000;
    if (options.forceRefresh === true || expiring) {
      if (!this.#tokens.refreshToken) {
        this.#tokens = undefined;
        this.#state = 'signed_out';
        this.#clearDelegatedCredential();
        throw new DevtoolsAuthRequiredError('Your sign-in expired; sign in again');
      }
      const generation = this.#generation;
      const current = this.#tokens;
      let refreshing = this.#refreshing;
      if (!refreshing || refreshing.generation !== generation) {
        const refreshPromise =
          this.#auth.kind === 'firebase'
            ? this.#requiredFirebaseDriver().refresh(current)
            : this.#discovery !== undefined && this.#registration !== undefined
              ? this.#requiredDriver().refresh(this.#discovery, this.#registration, current)
              : undefined;
        if (refreshPromise === undefined) {
          this.#tokens = undefined;
          this.#state = 'signed_out';
          this.#clearDelegatedCredential();
          throw new DevtoolsAuthRequiredError('Your sign-in expired; sign in again');
        }
        refreshing = {
          generation,
          promise: refreshPromise,
        };
        this.#refreshing = refreshing;
      }
      try {
        const tokens = await refreshing.promise;
        this.#assertGeneration(generation);
        await this.#storeDelegatedCredential(tokens);
        this.#assertGeneration(generation);
        this.#tokens = tokens;
      } catch {
        if (this.#generation === generation) {
          this.#tokens = undefined;
          this.#state = 'signed_out';
          this.#clearDelegatedCredential();
        }
        throw new DevtoolsAuthRequiredError('Your sign-in expired; sign in again');
      } finally {
        if (this.#refreshing === refreshing) {
          this.#refreshing = undefined;
        }
      }
    }
    this.#state = 'signed_in';
    return this.#tokens.accessToken;
  }

  noteBearerChallenge(status: number, header: string | null): void {
    const challenge = parseBearerChallenge(header);
    if (
      status !== 403 ||
      challenge?.error !== 'insufficient_scope' ||
      challenge.scopes.length === 0
    ) {
      return;
    }
    this.#generation += 1;
    this.#refreshing = undefined;
    this.#requestedScopes = canonicalScopes(
      this.#auth.kind === 'microsoft'
        ? [
            ...this.#requestedScopes,
            ...(this.#discovery?.scopes ?? []),
            ...(this.#tokens?.scope ?? []),
          ]
        : [
            ...this.#requestedScopes,
            ...(this.#discovery?.scopes ?? []),
            ...(this.#tokens?.scope ?? []),
            ...challenge.scopes,
          ],
    );
    this.#tokens = undefined;
    this.#clearDelegatedCredential();
    this.#pending = undefined;
    this.#state = 'reauthorization_required';
    this.#message =
      this.#auth.kind === 'firebase'
        ? 'This Firebase user is missing required app permissions; update its custom claims, then sign in again'
        : this.#auth.kind === 'microsoft'
          ? 'This Microsoft user is missing required app permissions; update its Entra app roles or claims, then sign in again'
          : 'Additional permission is required; sign in again to continue';
    this.#errorCode = undefined;
  }

  /** Drop a credential rejected by the MCP verifier while retaining a browser-safe repair state. */
  rejectToken(): void {
    this.#generation += 1;
    this.#refreshing = undefined;
    this.#pending = undefined;
    this.#firebasePending = undefined;
    this.#tokens = undefined;
    this.#clearDelegatedCredential();
    this.#state = 'error';
    this.#errorCode = 'oauth_token_rejected';
    this.#message =
      'The MCP server rejected the issued token. Verify its issuer, signing key, and configured audience, then sign in again.';
  }

  clear(): void {
    this.#generation += 1;
    this.#refreshing = undefined;
    this.#discovery = undefined;
    this.#registration = undefined;
    this.#pending = undefined;
    this.#firebasePending = undefined;
    this.#tokens = undefined;
    this.#clearDelegatedCredential();
    this.#driver = undefined;
    this.#requestedScopes = [];
    this.#message = undefined;
    this.#errorCode = undefined;
    this.#state = this.#auth.kind === 'unsupported' ? 'unsupported' : 'signed_out';
  }

  async #storeDelegatedCredential(tokens: McpOAuthTokens): Promise<void> {
    await storeDevtoolsDelegatedCredential({
      auth: this.#auth,
      resource: this.#resource,
      tokens,
      sink: this.#delegatedCredentialSink,
    });
  }

  #clearDelegatedCredential(): void {
    this.#delegatedCredentialSink?.clearResource(this.#resource);
  }

  #visibleScopes(): readonly string[] {
    return canonicalScopes([
      ...this.#requestedScopes,
      ...(this.#tokens?.scope ?? []),
      ...(this.#pending?.scopes ?? []),
    ]);
  }

  #requiredDriver(): DevtoolsOAuthDriver {
    if (!this.#driver && this.#selectedIssuer && this.#driverFactory) {
      this.#driver = this.#driverFactory(this.#selectedIssuer);
    }
    if (!this.#driver) {
      throw new Error(
        `${this.#auth.kind === 'unsupported' ? this.#auth.method : 'configured'} authentication is not supported in Devtools yet`,
      );
    }
    return this.#driver;
  }

  #requiredFirebaseDriver(): DevtoolsFirebaseDriver {
    if (!this.#firebaseDriver) {
      throw new Error('Firebase authentication is not supported in Devtools yet');
    }
    return this.#firebaseDriver;
  }

  async #startFirebase(): Promise<string> {
    const generation = ++this.#generation;
    this.#refreshing = undefined;
    this.#pending = undefined;
    this.#firebasePending = undefined;
    this.#tokens = undefined;
    this.#clearDelegatedCredential();
    this.#state = 'authorizing';
    this.#message = undefined;
    this.#errorCode = undefined;
    try {
      const pending = this.#requiredFirebaseDriver().beginAuthorization();
      this.#assertGeneration(generation);
      this.#firebasePending = pending;
      return pending.authorizationUrl;
    } catch (error) {
      if (this.#generation === generation) {
        this.#state = 'error';
        const failure = safeFailure(error, 'Could not start Firebase sign-in');
        this.#message = failure.message;
        this.#errorCode = failure.errorCode;
      }
      throw error;
    }
  }

  #configuredIssuers(): readonly string[] {
    if (this.#auth.kind === 'oidc') return [this.#auth.issuer];
    if (this.#auth.kind === 'federatedOidc') return [...this.#auth.issuers];
    if (this.#auth.kind === 'microsoft') return [microsoftIssuer(this.#auth.tenantId)];
    return [];
  }

  #resolveIssuer(requestedIssuer: string | undefined): string {
    if (this.#auth.kind === 'unsupported') {
      throw new Error(`${this.#auth.method} sign-in is not supported in Devtools yet`);
    }
    const issuers = this.#configuredIssuers();
    if (requestedIssuer !== undefined) {
      if (!issuers.includes(requestedIssuer)) {
        throw new DevtoolsAuthRequiredError('Selected identity provider is not configured');
      }
      return requestedIssuer;
    }
    if (this.#selectedIssuer !== undefined && issuers.includes(this.#selectedIssuer)) {
      return this.#selectedIssuer;
    }
    if (issuers.length === 1 && issuers[0] !== undefined) return issuers[0];
    if (issuers.length > 1) {
      throw new DevtoolsAuthRequiredError('Choose an identity provider to sign in');
    }
    throw new DevtoolsAuthRequiredError('No identity provider is configured');
  }

  #assertGeneration(generation: number): void {
    if (this.#generation !== generation) {
      throw new DevtoolsAuthRequiredError('Sign-in was cancelled');
    }
  }
}
