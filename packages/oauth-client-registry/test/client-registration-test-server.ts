import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import express from 'express';
import { safeClientRegistrationHandler } from '../src/client-registration-handler.js';

type StoredOAuthClient = OAuthClientInformationFull & {
  readonly application_type: 'web' | 'native';
  readonly token_endpoint_auth_method: 'none' | 'client_secret_post';
  readonly noodle_redirect_policy_version: 1;
};

export type RegisteredClientStoreMode =
  | 'identity'
  | 'modify-non-policy'
  | 'drop-policy-field'
  | 'mutate-policy-field'
  | 'invalid-full-record';

class InMemoryRegisteredClientsStore implements OAuthRegisteredClientsStore {
  readonly registeredClients: Record<string, unknown>[] = [];

  constructor(private readonly mode: RegisteredClientStoreMode = 'identity') {}

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.registeredClients.find((client) => client.client_id === clientId) as
      | OAuthClientInformationFull
      | undefined;
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): Promise<OAuthClientInformationFull> {
    const stored = storedClientForMode(client as StoredOAuthClient, this.mode);
    this.registeredClients.push(stored);
    await Promise.resolve();
    return stored as OAuthClientInformationFull;
  }
}

export interface ClientRegistrationTestServer {
  readonly baseUrl: string;
  readonly store: InMemoryRegisteredClientsStore;
  close(): Promise<void>;
}

export async function startClientRegistrationTestServer(
  storeMode: RegisteredClientStoreMode = 'identity',
): Promise<ClientRegistrationTestServer> {
  const store = new InMemoryRegisteredClientsStore(storeMode);
  const app = express();
  app.use('/register', safeClientRegistrationHandler({ clientsStore: store }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl,
    store,
    close: () => closeServer(server),
  };
}

function storedClientForMode(
  client: StoredOAuthClient,
  mode: RegisteredClientStoreMode,
): Record<string, unknown> {
  switch (mode) {
    case 'modify-non-policy':
      return { ...client, client_name: 'Store-enforced client name' };
    case 'drop-policy-field': {
      const { noodle_redirect_policy_version: _marker, ...withoutMarker } = client;
      return withoutMarker;
    }
    case 'mutate-policy-field':
      return { ...client, redirect_uris: ['https://store.example/private/callback'] };
    case 'invalid-full-record': {
      const { client_id: _clientId, ...withoutClientId } = client;
      return withoutClientId;
    }
    case 'identity':
      return client;
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}
