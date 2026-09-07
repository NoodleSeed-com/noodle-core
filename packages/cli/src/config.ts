import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Local CLI configuration for the hosted workflow. Persisted at `~/.noodle/config.json` with `0600` perms
 * (the dir `0700`) because it can hold a control-plane auth token. The token is **never logged** — only
 * {@link maskToken}'d. Resolution precedence everywhere is **flag > env > config > default**.
 */
export interface NoodleConfig {
  /** Default deploy-service base URL (e.g. `https://cloud.noodleseed.dev`). */
  readonly serviceUrl?: string;
  /** Control-plane bearer token. Sensitive — stored `0600`, never logged. */
  readonly authToken?: string;
  readonly authTokenExpiresAt?: string;
  /** Self-hosted Noodle authorization-server issuer for service-backed CLI login. */
  readonly oauthIssuer?: string;
  /** Dynamic OAuth client id registered by the CLI for service-backed login. */
  readonly oauthClientId?: string;
  /** Rotating refresh token issued by the Noodle authorization server. Sensitive. */
  readonly oauthRefreshToken?: string;
  /** OAuth protected resource bound to this profile's rotating refresh token. */
  readonly oauthResource?: string;
  /** Legacy direct-Google OAuth client ID retained only for compatibility during the fallback window. */
  readonly googleClientId?: string;
  /** Legacy direct-Google refresh token retained only for fallback compatibility. Sensitive. */
  readonly refreshToken?: string;
  /** Legacy cached Google ID token. Sensitive; refreshed only on the compatibility path. */
  readonly idToken?: string;
  readonly idTokenExpiresAt?: string;
  readonly identity?: {
    readonly subject: string;
    readonly email: string;
  };
  /** Default target runtime for config management. */
  readonly defaultRuntime?: 'local' | 'cloud' | 'other';
  /** Default organization slug for deploy/config commands. */
  readonly defaultOrg?: string;
  /** Default application slug for deploy/config commands. */
  readonly defaultApp?: string;
  /** Default environment name. */
  readonly defaultEnv?: string;
  /** Local metadata for periodic npm update checks. */
  readonly updateCheck?: {
    readonly checkedAt: string;
    readonly latestVersion?: string;
    readonly skillsLatestVersion?: string;
    /** Prompt snooze deadline (ISO): the default update prompt stays quiet until then. */
    readonly snoozedUntil?: string;
  };
}

/**
 * A normal invocation supplies the user's OS home and stores data under `.noodle`.
 * A validated plugin invocation supplies an explicit, already-isolated configuration root.
 */
export type ConfigLocation = string | { readonly configHome: string };

/** A locally-cached record of a deployed server. Contains metadata only; credentials are not stored here. */
export interface SavedServer {
  readonly deploymentId: string;
  readonly url: string;
  readonly createdAt: string;
}

export function configDir(home: ConfigLocation = homedir()): string {
  return typeof home === 'string' ? join(home, '.noodle') : home.configHome;
}
export function configPath(home: ConfigLocation = homedir()): string {
  return join(configDir(home), 'config.json');
}
export function serversPath(home: ConfigLocation = homedir()): string {
  return join(configDir(home), 'servers.json');
}

/** Read the config, or an empty config if absent/unreadable/corrupt (never throws). */
export function readConfig(home: ConfigLocation = homedir()): NoodleConfig {
  try {
    return JSON.parse(readFileSync(configPath(home), 'utf8')) as NoodleConfig;
  } catch {
    return {};
  }
}

/** Write the config with `0700` dir / `0600` file perms (chmod even if the file pre-existed looser). */
export function writeConfig(config: NoodleConfig, home: ConfigLocation = homedir()): void {
  writeSecure(configPath(home), `${JSON.stringify(config, null, 2)}\n`, home);
}

/** Clear the stored auth token (logout), keeping the service URL. Removes the file if nothing remains. */
export function clearConfig(home: ConfigLocation = homedir()): void {
  const {
    authToken: _authToken,
    authTokenExpiresAt: _authTokenExpiresAt,
    oauthIssuer: _oauthIssuer,
    oauthClientId: _oauthClientId,
    oauthRefreshToken: _oauthRefreshToken,
    oauthResource: _oauthResource,
    refreshToken: _refreshToken,
    idToken: _idToken,
    idTokenExpiresAt: _idTokenExpiresAt,
    identity: _identity,
    googleClientId: _googleClientId,
    ...rest
  } = readConfig(home);
  if (Object.keys(rest).length === 0) {
    try {
      rmSync(configPath(home), { force: true });
    } catch {}
    return;
  }
  writeConfig(rest, home);
}

/** Read the saved-servers cache (empty if absent/corrupt). */
export function readServers(home: ConfigLocation = homedir()): SavedServer[] {
  try {
    const parsed = JSON.parse(readFileSync(serversPath(home), 'utf8'));
    return Array.isArray(parsed) ? (parsed as SavedServer[]) : [];
  } catch {
    return [];
  }
}

/** Append a deployed server to the local cache (`0600`). */
export function appendServer(server: SavedServer, home: ConfigLocation = homedir()): void {
  const list = readServers(home);
  list.push(server);
  writeSecure(serversPath(home), `${JSON.stringify(list, null, 2)}\n`, home);
}

/** Resolve the effective deploy-service URL: flag > `NOODLE_SERVICE_URL` > config (undefined → caller default). */
export function resolveServiceUrl(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  config: NoodleConfig,
): string | undefined {
  return flag ?? env.NOODLE_SERVICE_URL ?? config.serviceUrl;
}

/** Resolve the effective control-plane auth token: flag > `NOODLE_AUTH_TOKEN` > config. */
export function resolveAuthToken(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  config: NoodleConfig,
): string | undefined {
  return flag ?? env.NOODLE_AUTH_TOKEN ?? config.authToken;
}

/** Mask a token for display: `abcd…yz`, never the full value. */
export function maskToken(token: string | undefined): string {
  if (!token) return '(none)';
  return token.length <= 8 ? '********' : `${token.slice(0, 4)}…${token.slice(-2)}`;
}

/** Write a file under `~/.noodle` with a `0700` dir and a `0600` file (idempotent chmod). */
function writeSecure(path: string, contents: string, home: ConfigLocation): string {
  const dir = configDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}
