import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationSignature } from '@noodle-borg/compiler';
import type { Connector, ConnectorCall } from '@noodle-borg/runtime';

const READ_SIGNATURE: OperationSignature = {
  type: 'read',
  input: { type: 'object', properties: {}, additionalProperties: false },
  output: {
    type: 'object',
    properties: {
      marker: { type: 'string' },
      path: { type: 'string' },
    },
    required: ['marker', 'path'],
    additionalProperties: false,
  },
};

const ACTION_SIGNATURE: OperationSignature = {
  ...READ_SIGNATURE,
  type: 'action',
};

interface BackendCall {
  readonly method: string;
  readonly path: string;
  readonly authorization?: string;
}

export interface CustomerTlsBackends {
  readonly a: CustomerTlsBackend;
  readonly b: CustomerTlsBackend;
  readonly certificate: Buffer;
  close(): Promise<void>;
}

interface CustomerTlsBackend {
  readonly origin: string;
  readonly calls: BackendCall[];
}

interface LocalCertificate {
  readonly root: string;
  readonly key: Buffer;
  readonly cert: Buffer;
}

/**
 * Start two real TLS listeners. The route presented to the runtime remains a policy-valid public
 * HTTPS URL; only this injected test connector maps that validated route to a loopback listener.
 */
export async function startCustomerTlsBackends(): Promise<CustomerTlsBackends> {
  const certificate = makeLocalCertificate();
  const servers: Server[] = [];
  try {
    const a = await startBackend('tenant-a', certificate, servers);
    const b = await startBackend('tenant-b', certificate, servers);
    const backends = {
      a,
      b,
      certificate: certificate.cert,
      async close() {
        await Promise.all(servers.map(closeServer));
        rmSync(certificate.root, { recursive: true, force: true });
      },
    };
    return backends;
  } catch (error) {
    await Promise.all(servers.map(closeServer));
    rmSync(certificate.root, { recursive: true, force: true });
    throw error;
  }
}

export function createCustomerRouteConnector(input: {
  readonly routes: Readonly<Record<string, string>>;
  readonly certificate: Buffer;
  readonly calls: ConnectorCall[];
}): Connector {
  return {
    id: 'customer_records',
    version: '1.0.0',
    signature: (operation) =>
      operation === 'list_records'
        ? READ_SIGNATURE
        : operation === 'archive_records'
          ? ACTION_SIGNATURE
          : undefined,
    async invoke(call) {
      input.calls.push(call);
      const route = call.route?.baseUrl;
      const backend = route === undefined ? undefined : input.routes[route];
      if (backend === undefined) throw new Error('test connector received an unexpected route');
      const basePath = new URL(route).pathname.replace(/\/+$/, '');
      const action = call.operation === 'archive_records';
      return requestJson(
        `${backend}${basePath}/${action ? 'archive' : 'records'}`,
        input.certificate,
        action ? 'POST' : 'GET',
      );
    },
  };
}

async function startBackend(
  marker: string,
  certificate: LocalCertificate,
  servers: Server[],
): Promise<CustomerTlsBackend> {
  const calls: BackendCall[] = [];
  const server = createServer({ key: certificate.key, cert: certificate.cert }, (req, res) => {
    calls.push({
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      ...(req.headers.authorization === undefined
        ? {}
        : { authorization: req.headers.authorization }),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ marker, path: req.url ?? '/' }));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const backend = { origin, calls };
  // The suite wrapper is registered after both listeners have started.
  return backend;
}

function makeLocalCertificate(): LocalCertificate {
  const root = mkdtempSync(join(tmpdir(), 'noodle-customer-route-tls-'));
  const keyPath = join(root, 'localhost-key.pem');
  const certPath = join(root, 'localhost-cert.pem');
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-subj',
        '/CN=127.0.0.1',
        '-days',
        '3650',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
        '-addext',
        'basicConstraints=critical,CA:TRUE',
      ],
      { stdio: 'ignore' },
    );
    return {
      root,
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function requestJson(url: string, certificate: Buffer, method: 'GET' | 'POST'): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(url, { ca: certificate, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.once('error', reject);
      res.once('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.once('error', reject);
    req.end();
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
