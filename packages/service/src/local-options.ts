import type { Server } from 'node:http';
import type { ConfirmationNonceLedger, RequestStateManager } from '@noodle-borg/protocol';
import type { JSONWebKeySet } from 'jose';
import type { LocalDevtoolsDelegatedCredentialSink } from './local-devtools-delegated-credentials.js';
import type { LocalDevtoolsDelegatedExchangeRuntime } from './local-devtools-delegated-exchange.js';
import type { ServerRegistry } from './registry.js';
import type { ConfigStore, TenantBridgeAuthConfig } from './store.js';

type LocalRuntimeOptions = {
  readonly assistantStore?: import('@noodle-borg/assistant-gateway/portable').AssistantStore;
  readonly assistantAppearance?: import('@noodle-borg/assistant-gateway/portable').AssistantAppearanceSettingsStore;
  readonly publicEmbeds?: import('@noodle-borg/assistant-gateway/portable').PublicEmbedStore;
  readonly elevations?: import('@noodle-borg/assistant-gateway/portable').AssistantElevationStore;
  readonly admissionCounters?: import('@noodle-borg/admission-limits/portable').DailyCounterStore;
  readonly knowledge?: import('@noodle-borg/knowledge-operations/portable').KnowledgeServiceStores;
};
export interface LocalServeServiceOptions {
  readonly host?: string;
  readonly port?: number;
  readonly configStore?: ConfigStore;
  readonly localDevtoolsDirectFirebaseAuth?: boolean;
  readonly localDevtoolsDirectMicrosoftAuth?: boolean;
  readonly localDevtoolsDelegatedExchange?: LocalDevtoolsDelegatedExchangeRuntime;
  readonly localDevtoolsResolveBridgeAuth?: (
    auth: TenantBridgeAuthConfig,
    resource: string,
  ) => Promise<TenantBridgeAuthConfig>;
  readonly customerVerifierAllowInsecureLocalhost?: boolean;
  readonly customerVerifierFirebaseJwks?: JSONWebKeySet;
  readonly customerVerifierFirebaseJwksUri?: string;
  readonly mcpRequestState?: RequestStateManager;
  readonly mcpConfirmationNonceLedger?: ConfirmationNonceLedger;
  readonly runtime?: LocalRuntimeOptions;
}
export interface LocalRunningService {
  readonly http: Server;
  readonly url: string;
  readonly port: number;
  readonly registry: ServerRegistry;
  readonly localDevtoolsDelegatedCredentials?: LocalDevtoolsDelegatedCredentialSink;
  close(): Promise<void>;
}
