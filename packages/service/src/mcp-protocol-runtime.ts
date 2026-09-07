import {
  type McpProtocolMode,
  RequestStateManager,
  requestStateSecretBox,
} from '@noodle-borg/protocol';
import type { SecretBox } from '@noodle-borg/runtime';

export interface HostedMcpRequestStateInput {
  readonly secretMasterKey?: string;
  readonly secretBox?: SecretBox;
}

/**
 * Build the fleet-shared request-state manager. Static-key deployments use an HKDF domain-separated key;
 * KMS deployments reuse the configured envelope-encryption custodian because its raw KEK cannot be
 * exported for HKDF.
 */
export function createHostedMcpRequestStateManager(
  input: HostedMcpRequestStateInput,
): RequestStateManager | undefined {
  if (input.secretMasterKey !== undefined) {
    return new RequestStateManager(
      requestStateSecretBox(Buffer.from(input.secretMasterKey, 'base64')),
    );
  }
  return input.secretBox === undefined ? undefined : new RequestStateManager(input.secretBox);
}

/** Resolve the temporary origin-wide rollout gate from operator configuration. */
export function resolveMcpProtocolMode(value: string | undefined): McpProtocolMode {
  if (value === undefined || value === 'dual') return 'dual';
  if (value === 'legacy-only') return value;
  throw new Error('NOODLE_MCP_PROTOCOL_MODE must be dual or legacy-only');
}
