import { describe, expect, it } from 'vitest';
import {
  digestMcpArguments,
  type RequestStateBinding,
  RequestStateError,
  RequestStateManager,
  requestStateSecretBox,
} from '../src/request-state.js';
import { toolRequestStateBinding } from '../src/v2/input-required.js';
import { resolvedArtifact } from './harness.js';

const masterKey = (fill: number): Buffer => Buffer.alloc(32, fill);
const pendingRequest = { id: 'next_input', interaction: 'input' as const };

function binding(overrides: Partial<RequestStateBinding> = {}): RequestStateBinding {
  return {
    deploymentId: 'dep_123',
    serverVersion: '1.2.3',
    method: 'tools/call',
    target: 'create_ticket',
    principal: 'user_123',
    argumentDigest: digestMcpArguments({ subject: 'Help' }),
    ...overrides,
  };
}

function manager(fill = 1, now = 10_000): RequestStateManager {
  return new RequestStateManager(requestStateSecretBox(masterKey(fill)), {
    now: () => now,
    maxRounds: 4,
    maxTokenBytes: 12_000,
  });
}

async function rejectionOf(attempt: Promise<unknown>): Promise<RequestStateError> {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof RequestStateError) return error;
    throw error;
  }
  throw new Error('expected request state rejection');
}

describe('sealed MCP request state', () => {
  it('round-trips answers and binding without exposing plaintext', async () => {
    const state = manager();
    const token = await state.seal({
      binding: binding(),
      responses: { team: { action: 'accept', content: { team: 'support' } } },
      round: 1,
      expiresAt: 20_000,
      nonce: 'nonce_1',
      pendingRequest,
    });

    expect(token).not.toContain('support');
    await expect(state.open(token, binding())).resolves.toMatchObject({
      responses: { team: { action: 'accept', content: { team: 'support' } } },
      round: 1,
      nonce: 'nonce_1',
    });
  });

  it.each([
    ['method', { method: 'prompts/get' as const }, 'request_state_binding_mismatch'],
    ['target', { target: 'delete_ticket' }, 'request_state_binding_mismatch'],
    ['principal', { principal: 'user_456' }, 'request_state_binding_mismatch'],
    [
      'arguments',
      { argumentDigest: digestMcpArguments({ subject: 'Changed' }) },
      'request_state_argument_mismatch',
    ],
    ['deployment', { deploymentId: 'dep_other' }, 'request_state_binding_mismatch'],
    ['server version', { serverVersion: '9.9.9' }, 'request_state_binding_mismatch'],
  ] as const)('fails closed on a wrong %s binding with a safe reason', async (_label, override, reason) => {
    const state = manager();
    const token = await state.seal({
      binding: binding(),
      responses: {},
      round: 1,
      expiresAt: 20_000,
      nonce: 'nonce_1',
      pendingRequest,
    });
    const error = await rejectionOf(state.open(token, binding(override)));

    expect(error.reason).toBe(reason);
    expect(error.message).toBe('Invalid or expired requestState');
    expect(error.message).not.toContain(token);
    for (const value of Object.values(override)) {
      expect(error.message).not.toContain(String(value));
    }
  });

  it('fails closed on a wrong key or tampered ciphertext without leaking either value', async () => {
    const token = await manager(1).seal({
      binding: binding(),
      responses: { secret: { action: 'accept', content: { answer: 'do-not-leak' } } },
      round: 1,
      expiresAt: 20_000,
      nonce: 'nonce_1',
      pendingRequest,
    });
    const tampered = `${token.slice(0, -2)}xx`;

    for (const attempt of [
      () => manager(2).open(token, binding()),
      () => manager(1).open(tampered, binding()),
    ]) {
      try {
        await attempt();
        throw new Error('expected request state rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(RequestStateError);
        expect((error as RequestStateError).reason).toBe('request_state_verification_failed');
        expect((error as Error).message).not.toContain('do-not-leak');
        expect((error as Error).message).not.toContain(token);
      }
    }
  });

  it('rejects expiry, exceeded rounds, and oversized state', async () => {
    const expired = await manager().seal({
      binding: binding(),
      responses: {},
      round: 1,
      expiresAt: 9_999,
      nonce: 'nonce_1',
      pendingRequest,
    });
    const expiredError = await rejectionOf(manager().open(expired, binding()));
    expect(expiredError.reason).toBe('request_state_expired');
    expect(expiredError.message).not.toContain(expired);

    await expect(
      manager().seal({
        binding: binding(),
        responses: {},
        round: 5,
        expiresAt: 20_000,
        nonce: 'nonce_1',
        pendingRequest,
      }),
    ).rejects.toThrow(RequestStateError);

    await expect(
      manager().seal({
        binding: binding(),
        responses: {
          huge: { action: 'accept', content: { value: 'x'.repeat(20_000) } },
        },
        round: 1,
        expiresAt: 20_000,
        nonce: 'nonce_1',
        pendingRequest,
      }),
    ).rejects.toThrow(RequestStateError);
    await expect(manager().open('x'.repeat(20_000), binding())).rejects.toThrow(RequestStateError);
  });

  it('uses a stable digest while stripping only the legacy adapter envelope', () => {
    expect(
      digestMcpArguments({
        b: 2,
        a: 1,
        __noodleInteraction: { responses: { attacker: true } },
      }),
    ).toBe(digestMcpArguments({ a: 1, b: 2 }));
    expect(digestMcpArguments({ a: 1, b: 2 })).not.toBe(digestMcpArguments({ a: 1, b: 3 }));
  });

  it('keeps service and platform request-state principals in distinct namespaces', () => {
    const artifact = resolvedArtifact();
    const service = toolRequestStateBinding(
      artifact,
      { caller: { subject: 'shared-subject', identityKind: 'service' } },
      'get_order',
      { id: 'order-1' },
    );
    const platform = toolRequestStateBinding(
      artifact,
      { caller: { subject: 'shared-subject', identityKind: 'platform' } },
      'get_order',
      { id: 'order-1' },
    );

    expect(service.principal).toBe('["service","shared-subject"]');
    expect(platform.principal).toBe('["platform","shared-subject"]');
  });

  /**
   * An anonymous caller is a distinct principal kind, so its request state must not share a namespace
   * with a platform user who happens to carry the same subject string. The kind check is a chain of
   * positive tests with a platform fallthrough, so a new kind lands in the platform bucket silently —
   * `tsc` cannot see it, which is exactly why this is asserted.
   */
  it('keeps anonymous request state out of the platform namespace', () => {
    const artifact = resolvedArtifact();
    const anonymous = toolRequestStateBinding(
      artifact,
      { caller: { subject: 'shared-subject', identityKind: 'anonymous' } },
      'get_order',
      { id: 'order-1' },
    );
    const platform = toolRequestStateBinding(
      artifact,
      { caller: { subject: 'shared-subject', identityKind: 'platform' } },
      'get_order',
      { id: 'order-1' },
    );

    expect(anonymous.principal).toBe('["anonymous","shared-subject"]');
    expect(anonymous.principal).not.toBe(platform.principal);
  });
});
