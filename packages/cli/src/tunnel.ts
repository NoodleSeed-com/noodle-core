import { spawn as nodeSpawn } from 'node:child_process';

/**
 * Dev tunnel — phase 1 (cloudflared stopgap). See ADR 0103.
 *
 * Wraps `cloudflared tunnel --url <loopback>` (Cloudflare Quick Tunnels) so a cloud-hosted AI client
 * can reach the loopback `noodle dev` server. `cloudflared` is an external, user-installed binary
 * (Apache-2.0) — never an npm dependency and never bundled. The dev server stays bound to loopback;
 * cloudflared dials it locally. This module never logs request/response bodies, headers, or tokens —
 * it only parses the assigned public URL and never forwards raw child output.
 */

/** The subset of `node:child_process` ChildProcess this module needs, so tests can inject a fake. */
export interface TunnelProcess {
  readonly stdout: NodeJS.EventEmitter | null;
  readonly stderr: NodeJS.EventEmitter | null;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnFn = (command: string, args: readonly string[]) => TunnelProcess;

export interface StartTunnelOptions {
  /** The loopback origin of the dev server, e.g. `http://127.0.0.1:54321`. */
  readonly localOrigin: string;
  /** The full loopback MCP URL the dev server serves (origin + tenant path). */
  readonly localMcpUrl: string;
  /** Injectable spawner (defaults to `node:child_process` spawn); used by tests to avoid cloudflared. */
  readonly spawn?: SpawnFn;
  /** Max time to wait for cloudflared to report a URL before giving up. */
  readonly timeoutMs?: number;
}

export interface TunnelHandle {
  /** The public Cloudflare origin, e.g. `https://blue-cat-1234.trycloudflare.com`. */
  readonly publicOrigin: string;
  /** The public MCP URL (public origin + the dev server's tenant path). */
  readonly publicMcpUrl: string;
  /** Stop the cloudflared process. */
  close(): Promise<void>;
}

const CLOUDFLARED = 'cloudflared';
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const INSTALL_HINT =
  'cloudflared not found. Install it (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), then retry `noodle dev --tunnel`.';

/**
 * Start a Cloudflare Quick Tunnel to the loopback dev server and resolve once the public URL appears.
 * Rejects with install guidance when the binary is missing, or if cloudflared exits / times out first.
 */
export async function startTunnel(options: StartTunnelOptions): Promise<TunnelHandle> {
  const spawnFn: SpawnFn = options.spawn ?? ((command, args) => nodeSpawn(command, [...args]));
  const timeoutMs = options.timeoutMs ?? 20_000;
  const child = spawnFn(CLOUDFLARED, ['tunnel', '--url', options.localOrigin]);

  return new Promise<TunnelHandle>((resolve, reject) => {
    let settled = false;
    let buffer = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`cloudflared did not report a tunnel URL within ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    // Parse the assigned URL from cloudflared's output. We deliberately never echo the raw output.
    const onData = (chunk: Buffer | string): void => {
      if (settled) return;
      buffer += chunk.toString();
      const match = buffer.match(URL_RE);
      if (!match) return;
      const publicOrigin = match[0];
      const publicMcpUrl = publicOrigin + options.localMcpUrl.slice(options.localOrigin.length);
      finish(() =>
        resolve({
          publicOrigin,
          publicMcpUrl,
          close: () =>
            new Promise<void>((res) => {
              child.on('exit', () => res());
              child.kill('SIGTERM');
            }),
        }),
      );
    };

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err: Error & { code?: string }) => {
      finish(() =>
        reject(new Error(err.code === 'ENOENT' ? INSTALL_HINT : `cloudflared: ${err.message}`)),
      );
    });
    child.on('exit', (code) => {
      finish(() =>
        reject(new Error(`cloudflared exited (code ${code ?? 'null'}) before opening a tunnel`)),
      );
    });
  });
}
