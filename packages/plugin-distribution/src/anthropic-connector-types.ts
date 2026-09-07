import type { HostPackageRequest } from '@noodle-borg/agent-packaging';

export interface AnthropicConnectorOptions {
  readonly auth: 'none' | 'oauth-dcr';
  readonly categories: readonly string[];
  /** HTTPS origins authored as handoff candidates; portal ownership verification remains human. */
  readonly allowedLinks: readonly string[];
}

export interface NormalizedAnthropicConnectorOptions {
  readonly auth: 'none' | 'oauth_dcr';
  readonly categories: readonly string[];
  readonly allowedLinks: readonly string[];
}

export type AnthropicConnectorRequest = HostPackageRequest;
