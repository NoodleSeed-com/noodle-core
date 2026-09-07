import { createServer, type Server } from 'node:http';
import type { ServedArtifact } from '@noodle-borg/protocol';
import { createMcpHttpHandler, type HttpHandlerOptions } from './handler.js';

export interface ServeOptions extends HttpHandlerOptions {
  readonly target: ServedArtifact;
  /** Port to bind. Default `0` (an ephemeral port — read the bound port from the result). */
  readonly port?: number;
  /** Host/interface to bind. Default `127.0.0.1` (localhost) per the transport security guidance. */
  readonly host?: string;
}

export interface RunningServer {
  readonly http: Server;
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Start a `node:http` server serving a {@link ServedArtifact} over Streamable HTTP. Binds `127.0.0.1`
 * by default; a real remote deployment binds `0.0.0.0` behind a reverse proxy **and** Phase-3 auth.
 */
export function serveHttp(options: ServeOptions): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1';
  const endpoint = options.endpoint ?? '/mcp';
  const http = createServer(createMcpHttpHandler(options.target, options));

  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port ?? 0, host, () => {
      const address = http.address();
      const port = typeof address === 'object' && address ? address.port : (options.port ?? 0);
      resolve({
        http,
        port,
        url: `http://${host}:${port}${endpoint}`,
        close: () => new Promise<void>((res, rej) => http.close((e) => (e ? rej(e) : res()))),
      });
    });
  });
}
