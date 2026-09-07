import { SecretBox, staticMasterKeyProvider } from '@noodle-borg/runtime';
import { describe, expect, it } from 'vitest';
import {
  createHostedMcpRequestStateManager,
  resolveMcpProtocolMode,
} from '../src/mcp-protocol-runtime.js';

const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

describe('hosted MCP protocol runtime', () => {
  it('defaults the operator gate to dual and accepts only the rollback value', () => {
    expect(resolveMcpProtocolMode(undefined)).toBe('dual');
    expect(resolveMcpProtocolMode('dual')).toBe('dual');
    expect(resolveMcpProtocolMode('legacy-only')).toBe('legacy-only');
    expect(() => resolveMcpProtocolMode('modern-only')).toThrow(
      'NOODLE_MCP_PROTOCOL_MODE must be dual or legacy-only',
    );
  });

  it('derives one replica-stable request-state key from the static operator key', async () => {
    const first = createHostedMcpRequestStateManager({
      secretMasterKey: MASTER_KEY,
    });
    const second = createHostedMcpRequestStateManager({
      secretMasterKey: MASTER_KEY,
    });
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    const token = await first?.seal({
      responses: {},
      round: 1,
      expiresAt: Date.now() + 60_000,
      nonce: 'replica-stable',
      pendingRequest: { id: 'next_input', interaction: 'input' },
      binding: {
        deploymentId: 'dep-1',
        serverVersion: '1.0.0',
        method: 'tools/call',
        target: 'lookup',
        principal: 'anonymous',
        argumentDigest: 'digest',
      },
    });
    await expect(second?.open(token as string)).resolves.toMatchObject({
      nonce: 'replica-stable',
    });
  });

  it('uses the configured KMS-backed SecretBox when the raw key never enters the process', async () => {
    const secretBox = new SecretBox(staticMasterKeyProvider(MASTER_KEY, 'fake-kms'));
    const first = createHostedMcpRequestStateManager({ secretBox });
    const second = createHostedMcpRequestStateManager({ secretBox });
    const token = await first?.seal({
      responses: {},
      round: 1,
      expiresAt: Date.now() + 60_000,
      nonce: 'wrapped-replica-stable',
      pendingRequest: { id: 'next_input', interaction: 'input' },
      binding: {
        deploymentId: 'dep-1',
        serverVersion: '1.0.0',
        method: 'prompts/get',
        target: 'review',
        principal: 'anonymous',
        argumentDigest: 'digest',
      },
    });
    await expect(second?.open(token as string)).resolves.toMatchObject({
      nonce: 'wrapped-replica-stable',
    });
  });

  it('leaves ephemeral local serving on the protocol package process fallback', () => {
    expect(createHostedMcpRequestStateManager({})).toBeUndefined();
  });
});
