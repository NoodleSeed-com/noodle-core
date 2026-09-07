import { afterEach, describe, expect, it } from 'vitest';
import type { createDualEraMcpHandler } from '../src/v2/handler.js';
import { modernRpc } from './v2-harness.js';
import {
  setupConfirmationApp as setup,
  TestConfirmationLedger,
} from './v2-mrtr-confirmation-harness.js';

const handlers: Array<ReturnType<typeof createDualEraMcpHandler>> = [];
afterEach(async () => {
  await Promise.all(handlers.splice(0).map((handler) => handler.close()));
});

function remember<T extends ReturnType<typeof createDualEraMcpHandler>>(handler: T): T {
  handlers.push(handler);
  return handler;
}

function resultOf(response: Awaited<ReturnType<typeof modernRpc>>): Record<string, unknown> {
  if (
    typeof response.json.result !== 'object' ||
    response.json.result === null ||
    Array.isArray(response.json.result)
  ) {
    throw new Error('expected result');
  }
  return response.json.result as Record<string, unknown>;
}

function confirmationRetry(
  handler: ReturnType<typeof createDualEraMcpHandler>,
  args: Record<string, unknown>,
  requestState: unknown,
  inputResponses: Record<string, unknown>,
  id: number,
  clientCapabilities: Record<string, unknown>,
) {
  return modernRpc(
    handler,
    'tools/call',
    {
      name: 'book_leave',
      arguments: args,
      requestState,
      inputResponses,
    },
    { id, clientCapabilities },
  );
}

function wrappedConfirmation(key = '__noodle_confirmation'): Record<string, unknown> {
  return {
    [key]: {
      method: 'elicitation/create',
      result: { action: 'accept', content: { confirm: true } },
    },
  };
}

describe('modern MRTR exact-action confirmation', () => {
  it('uses explicit host approval when the request does not declare form elicitation', async () => {
    const app = setup(new TestConfirmationLedger(), { confirmationFallback: 'host' });
    const handler = remember(app.handler);

    const response = await modernRpc(
      handler,
      'tools/call',
      {
        name: 'book_leave',
        arguments: { days: 2, reason: 'family' },
      },
      { clientCapabilities: {} },
    );

    expect(response.json).toMatchObject({
      result: {
        resultType: 'complete',
        structuredContent: { requestId: 'request-1' },
      },
    });
    expect(app.calls()).toBe(1);
  });

  it('presents a bounded open-object action payload without omitting its values', async () => {
    const app = setup(new TestConfirmationLedger(), { openActionPayload: true });
    const handler = remember(app.handler);

    const response = await modernRpc(
      handler,
      'tools/call',
      {
        name: 'book_leave',
        arguments: { days: 2, reason: 'chatgpt-canary-open-payload' },
      },
      { clientCapabilities: { elicitation: { form: {} } } },
    );

    expect(response.json).toMatchObject({
      result: {
        resultType: 'input_required',
        inputRequests: {
          __noodle_confirmation: { method: 'elicitation/create' },
        },
      },
    });
    expect(confirmationMessage(resultOf(response))).toContain('chatgpt-canary-open-payload');
    expect(app.calls()).toBe(0);
  });

  it('fails closed on a credential-shaped value inside an open-object action payload', async () => {
    const app = setup(new TestConfirmationLedger(), { openActionPayload: true });
    const handler = remember(app.handler);

    const response = await modernRpc(
      handler,
      'tools/call',
      {
        name: 'book_leave',
        arguments: { days: 2, reason: 'Bearer abcdefghijklmnopqrstuvwxyz012345' },
      },
      { clientCapabilities: { elicitation: { form: {} } } },
    );

    expect(response.json).toMatchObject({ error: { code: -32603 } });
    expect(response.text).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
    expect(app.calls()).toBe(0);
  });

  it('does not use host approval before missing input is collected', async () => {
    const app = setup(new TestConfirmationLedger(), {
      elicit: true,
      confirmationFallback: 'host',
    });
    const handler = remember(app.handler);

    const response = await modernRpc(
      handler,
      'tools/call',
      { name: 'book_leave', arguments: { days: 2 } },
      { clientCapabilities: {} },
    );

    expect(response.json).toMatchObject({
      error: {
        code: -32021,
        data: { requiredCapabilities: { elicitation: { form: {} } } },
      },
    });
    expect(app.calls()).toBe(0);
  });

  it('keeps explicit host approval behind MRTR when form elicitation is declared', async () => {
    const app = setup(new TestConfirmationLedger(), { confirmationFallback: 'host' });
    const handler = remember(app.handler);

    const response = await modernRpc(
      handler,
      'tools/call',
      {
        name: 'book_leave',
        arguments: { days: 2, reason: 'family' },
      },
      { clientCapabilities: { elicitation: { form: {} } } },
    );

    expect(response.json).toMatchObject({
      result: {
        resultType: 'input_required',
        inputRequests: {
          __noodle_confirmation: { method: 'elicitation/create' },
        },
      },
    });
    expect(app.calls()).toBe(0);
  });

  it('treats a bare elicitation declaration as form support before using host approval', async () => {
    const app = setup(new TestConfirmationLedger(), { confirmationFallback: 'host' });
    const handler = remember(app.handler);

    const response = await modernRpc(
      handler,
      'tools/call',
      {
        name: 'book_leave',
        arguments: { days: 2, reason: 'family' },
      },
      { clientCapabilities: { elicitation: {} } },
    );

    expect(response.json).toMatchObject({
      result: {
        resultType: 'input_required',
        inputRequests: {
          __noodle_confirmation: { method: 'elicitation/create' },
        },
      },
    });
    expect(app.calls()).toBe(0);
  });

  it('fails closed without explicit host approval when form elicitation is absent', async () => {
    const app = setup(new TestConfirmationLedger());
    const handler = remember(app.handler);

    const response = await modernRpc(
      handler,
      'tools/call',
      {
        name: 'book_leave',
        arguments: { days: 2, reason: 'family' },
      },
      { clientCapabilities: {} },
    );

    expect(response.json).toMatchObject({
      error: {
        code: -32021,
        data: { requiredCapabilities: { elicitation: { form: {} } } },
      },
    });
    expect(app.calls()).toBe(0);
  });

  it('does not downgrade an in-progress MRTR decline to host approval', async () => {
    const app = setup(new TestConfirmationLedger(), { confirmationFallback: 'host' });
    const handler = remember(app.handler);
    const args = { days: 2, reason: 'family' };
    const first = resultOf(
      await modernRpc(
        handler,
        'tools/call',
        { name: 'book_leave', arguments: args },
        { clientCapabilities: { elicitation: { form: {} } } },
      ),
    );

    const declined = await modernRpc(
      handler,
      'tools/call',
      {
        name: 'book_leave',
        arguments: args,
        requestState: first.requestState,
        inputResponses: {
          __noodle_confirmation: { action: 'decline' },
        },
      },
      { id: 2, clientCapabilities: {} },
    );

    expect(declined.json).toMatchObject({
      result: { resultType: 'complete', isError: true },
    });
    expect(declined.text).toContain('declined');
    expect(app.calls()).toBe(0);
  });

  it('presents the bounded review, executes once, and rejects replay', async () => {
    const ledger = new TestConfirmationLedger();
    const app = setup(ledger);
    const handler = remember(app.handler);
    const capabilities = { elicitation: { form: {} } };
    const args = { days: 3, reason: 'family', apiToken: 'secret-token-value' };

    const first = resultOf(
      await modernRpc(
        handler,
        'tools/call',
        { name: 'book_leave', arguments: args },
        { clientCapabilities: capabilities },
      ),
    );
    expect(first).toMatchObject({
      resultType: 'input_required',
      inputRequests: {
        __noodle_confirmation: {
          method: 'elicitation/create',
          params: {
            requestedSchema: {
              properties: { confirm: { type: 'boolean', default: false } },
              required: ['confirm'],
            },
          },
        },
      },
    });
    const message = confirmationMessage(first);
    expect(message).toContain('"days": 3');
    expect(message).toContain('"reason": "family"');
    expect(message).toContain('[REDACTED]');
    expect(message).not.toContain('secret-token-value');

    const accepted = await modernRpc(
      handler,
      'tools/call',
      {
        name: 'book_leave',
        arguments: args,
        requestState: first.requestState,
        inputResponses: {
          __noodle_confirmation: { action: 'accept', content: { confirm: true } },
        },
      },
      { id: 2, clientCapabilities: capabilities },
    );
    expect(accepted.json).toMatchObject({
      result: {
        resultType: 'complete',
        structuredContent: { requestId: 'request-1' },
      },
    });
    expect(app.calls()).toBe(1);

    const replayed = await modernRpc(
      handler,
      'tools/call',
      {
        name: 'book_leave',
        arguments: args,
        requestState: first.requestState,
        inputResponses: {
          __noodle_confirmation: { action: 'accept', content: { confirm: true } },
        },
      },
      { id: 3, clientCapabilities: capabilities },
    );
    expect(replayed.json).toMatchObject({
      error: { code: -32602, data: { reason: 'invalid_request_state' } },
    });
    expect(app.calls()).toBe(1);
    expect(app.observations.at(-1)?.errorKind).toBe('confirmation_replay');
  });

  it('fails closed when the nonce ledger is unavailable', async () => {
    const app = setup(undefined);
    const handler = remember(app.handler);
    const capabilities = { elicitation: { form: {} } };
    const args = { days: 2, reason: 'care' };
    const first = resultOf(
      await modernRpc(
        handler,
        'tools/call',
        { name: 'book_leave', arguments: args },
        { clientCapabilities: capabilities },
      ),
    );
    const retry = await modernRpc(
      handler,
      'tools/call',
      {
        name: 'book_leave',
        arguments: args,
        requestState: first.requestState,
        inputResponses: {
          __noodle_confirmation: { action: 'accept', content: { confirm: true } },
        },
      },
      { id: 2, clientCapabilities: capabilities },
    );

    expect(retry.json).toMatchObject({
      error: { code: -32602, data: { reason: 'invalid_request_state' } },
    });
    expect(app.calls()).toBe(0);
    expect(app.observations.at(-1)?.errorKind).toBe('confirmation_ledger_unavailable');
  });

  it('classifies a throwing nonce ledger as unavailable without dispatching', async () => {
    const ledger = new TestConfirmationLedger();
    ledger.available = false;
    const app = setup(ledger);
    const handler = remember(app.handler);
    const capabilities = { elicitation: { form: {} } };
    const args = { days: 2, reason: 'care' };
    const first = resultOf(
      await modernRpc(
        handler,
        'tools/call',
        { name: 'book_leave', arguments: args },
        { clientCapabilities: capabilities },
      ),
    );
    const retry = await modernRpc(
      handler,
      'tools/call',
      {
        name: 'book_leave',
        arguments: args,
        requestState: first.requestState,
        inputResponses: {
          __noodle_confirmation: { action: 'accept', content: { confirm: true } },
        },
      },
      { id: 2, clientCapabilities: capabilities },
    );

    expect(retry.json).toMatchObject({
      error: { code: -32602, data: { reason: 'invalid_request_state' } },
    });
    expect(app.calls()).toBe(0);
    expect(app.observations.at(-1)?.errorKind).toBe('confirmation_ledger_unavailable');
  });

  it('rejects replay of pre-confirmation input state after the shared nonce executes', async () => {
    const ledger = new TestConfirmationLedger();
    const app = setup(ledger, { elicit: true });
    const handler = remember(app.handler);
    const capabilities = { elicitation: { form: {} } };
    const args = { days: 2 };

    const input = resultOf(
      await modernRpc(
        handler,
        'tools/call',
        { name: 'book_leave', arguments: args },
        { clientCapabilities: capabilities },
      ),
    );
    const inputResponse = {
      reason: { action: 'accept' as const, content: { reason: 'family' } },
    };
    const confirmation = resultOf(
      await modernRpc(
        handler,
        'tools/call',
        {
          name: 'book_leave',
          arguments: args,
          requestState: input.requestState,
          inputResponses: inputResponse,
        },
        { id: 2, clientCapabilities: capabilities },
      ),
    );

    const approval = {
      __noodle_confirmation: {
        action: 'accept' as const,
        content: { confirm: true },
      },
    };
    const complete = await modernRpc(
      handler,
      'tools/call',
      {
        name: 'book_leave',
        arguments: args,
        requestState: confirmation.requestState,
        inputResponses: approval,
      },
      { id: 3, clientCapabilities: capabilities },
    );
    expect(complete.json).toMatchObject({
      result: {
        resultType: 'complete',
        structuredContent: { requestId: 'request-1' },
      },
    });
    expect(app.calls()).toBe(1);

    const replayedConfirmation = resultOf(
      await modernRpc(
        handler,
        'tools/call',
        {
          name: 'book_leave',
          arguments: args,
          requestState: input.requestState,
          inputResponses: inputResponse,
        },
        { id: 4, clientCapabilities: capabilities },
      ),
    );
    const replayedApproval = await modernRpc(
      handler,
      'tools/call',
      {
        name: 'book_leave',
        arguments: args,
        requestState: replayedConfirmation.requestState,
        inputResponses: approval,
      },
      { id: 5, clientCapabilities: capabilities },
    );

    expect(replayedApproval.json).toMatchObject({
      error: { code: -32602, data: { reason: 'invalid_request_state' } },
    });
    expect(app.calls()).toBe(1);
    expect(app.observations.at(-1)?.errorKind).toBe('confirmation_replay');
  });

  it('rejects confirmation preapproval injected alongside a pending input response', async () => {
    const ledger = new TestConfirmationLedger();
    const app = setup(ledger, { elicit: true });
    const handler = remember(app.handler);
    const capabilities = { elicitation: { form: {} } };
    const args = { days: 2 };
    const input = resultOf(
      await modernRpc(
        handler,
        'tools/call',
        { name: 'book_leave', arguments: args },
        { clientCapabilities: capabilities },
      ),
    );

    const injected = await modernRpc(
      handler,
      'tools/call',
      {
        name: 'book_leave',
        arguments: args,
        requestState: input.requestState,
        inputResponses: {
          reason: { action: 'accept', content: { reason: 'family' } },
          __noodle_confirmation: { action: 'accept', content: { confirm: true } },
        },
      },
      { id: 2, clientCapabilities: capabilities },
    );

    expect(injected.json).toMatchObject({
      error: { code: -32602, data: { reason: 'invalid_request_state' } },
    });
    expect(app.calls()).toBe(0);
  });

  it('rejects an earlier input answer overwritten alongside confirmation approval', async () => {
    const ledger = new TestConfirmationLedger();
    const app = setup(ledger, { elicit: true });
    const handler = remember(app.handler);
    const capabilities = { elicitation: { form: {} } };
    const args = { days: 2 };
    const input = resultOf(
      await modernRpc(
        handler,
        'tools/call',
        { name: 'book_leave', arguments: args },
        { clientCapabilities: capabilities },
      ),
    );
    const confirmation = resultOf(
      await modernRpc(
        handler,
        'tools/call',
        {
          name: 'book_leave',
          arguments: args,
          requestState: input.requestState,
          inputResponses: {
            reason: { action: 'accept', content: { reason: 'reviewed-value' } },
          },
        },
        { id: 2, clientCapabilities: capabilities },
      ),
    );

    const overwritten = await modernRpc(
      handler,
      'tools/call',
      {
        name: 'book_leave',
        arguments: args,
        requestState: confirmation.requestState,
        inputResponses: {
          reason: { action: 'accept', content: { reason: 'unreviewed-value' } },
          __noodle_confirmation: { action: 'accept', content: { confirm: true } },
        },
      },
      { id: 3, clientCapabilities: capabilities },
    );

    expect(overwritten.json).toMatchObject({
      error: { code: -32602, data: { reason: 'invalid_request_state' } },
    });
    expect(app.calls()).toBe(0);
  });

  it('does not burn a valid confirmation nonce before binding and response validation', async () => {
    const ledger = new TestConfirmationLedger();
    const app = setup(ledger);
    const handler = remember(app.handler);
    const capabilities = { elicitation: { form: {} } };
    const args = { days: 1, reason: 'care' };
    const confirmation = resultOf(
      await modernRpc(
        handler,
        'tools/call',
        { name: 'book_leave', arguments: args },
        { clientCapabilities: capabilities },
      ),
    );

    const malformed = await modernRpc(
      handler,
      'tools/call',
      {
        name: 'book_leave',
        arguments: args,
        requestState: confirmation.requestState,
        inputResponses: {
          __noodle_confirmation: { action: 'accept', content: { confirm: true } },
          extra: { action: 'accept', content: { ignored: true } },
        },
      },
      { id: 2, clientCapabilities: capabilities },
    );
    expect(malformed.json).toMatchObject({
      error: { code: -32602, data: { reason: 'invalid_request_state' } },
    });
    expect(ledger.consumed.size).toBe(0);

    const accepted = await modernRpc(
      handler,
      'tools/call',
      {
        name: 'book_leave',
        arguments: args,
        requestState: confirmation.requestState,
        inputResponses: {
          __noodle_confirmation: { action: 'accept', content: { confirm: true } },
        },
      },
      { id: 3, clientCapabilities: capabilities },
    );
    expect(accepted.json).toMatchObject({
      result: { structuredContent: { requestId: 'request-1' } },
    });
    expect(app.calls()).toBe(1);
    expect(ledger.consumed.size).toBe(1);
  });

  it('reissues an SDK-dropped confirmation envelope, then accepts one bare response once', async () => {
    const ledger = new TestConfirmationLedger();
    const app = setup(ledger);
    const handler = remember(app.handler);
    const capabilities = { elicitation: { form: {} } };
    const args = { days: 1, reason: 'care' };
    const first = resultOf(
      await modernRpc(
        handler,
        'tools/call',
        { name: 'book_leave', arguments: args },
        { clientCapabilities: capabilities },
      ),
    );

    const reissued = resultOf(
      await confirmationRetry(
        handler,
        args,
        first.requestState,
        wrappedConfirmation(),
        2,
        capabilities,
      ),
    );

    expect(reissued).toMatchObject({
      resultType: 'input_required',
      inputRequests: { __noodle_confirmation: { method: 'elicitation/create' } },
    });
    expect(reissued.requestState).toEqual(expect.any(String));
    expect(reissued.requestState).not.toBe(first.requestState);
    const [firstState, reissuedState] = await Promise.all([
      app.requestState.open(String(first.requestState)),
      app.requestState.open(String(reissued.requestState)),
    ]);
    expect(reissuedState).toMatchObject({
      round: firstState.round + 1,
      expiresAt: firstState.expiresAt,
      nonce: firstState.nonce,
      pendingRequest: firstState.pendingRequest,
    });
    expect(app.calls()).toBe(0);
    expect(ledger.consumed.size).toBe(0);
    expect(app.observations).toEqual([
      expect.objectContaining({ errorKind: 'dropped_input_response_envelope' }),
    ]);

    const accepted = await confirmationRetry(
      handler,
      args,
      reissued.requestState,
      {
        __noodle_confirmation: { action: 'accept', content: { confirm: true } },
      },
      3,
      capabilities,
    );
    expect(accepted.json).toMatchObject({
      result: { resultType: 'complete', structuredContent: { requestId: 'request-1' } },
    });
    expect(app.calls()).toBe(1);
    expect(ledger.consumed.size).toBe(1);

    const replayed = await confirmationRetry(
      handler,
      args,
      reissued.requestState,
      {
        __noodle_confirmation: { action: 'accept', content: { confirm: true } },
      },
      4,
      capabilities,
    );
    expect(replayed.json).toMatchObject({
      error: { code: -32602, data: { reason: 'invalid_request_state' } },
    });
    expect(app.calls()).toBe(1);
    expect(app.observations.at(-1)?.errorKind).toBe('confirmation_replay');
  });

  it('rejects wrong and mixed dropped keys without consuming the confirmation nonce', async () => {
    const ledger = new TestConfirmationLedger();
    const app = setup(ledger);
    const handler = remember(app.handler);
    const capabilities = { elicitation: { form: {} } };
    const args = { days: 1, reason: 'care' };
    const first = resultOf(
      await modernRpc(
        handler,
        'tools/call',
        { name: 'book_leave', arguments: args },
        { clientCapabilities: capabilities },
      ),
    );
    const wrong = await confirmationRetry(
      handler,
      args,
      first.requestState,
      wrappedConfirmation('wrong'),
      2,
      capabilities,
    );
    const mixed = await confirmationRetry(
      handler,
      args,
      first.requestState,
      {
        __noodle_confirmation: { action: 'accept', content: { confirm: true } },
        extra: { method: 'elicitation/create', result: { action: 'accept' } },
      },
      3,
      capabilities,
    );

    for (const response of [wrong, mixed]) {
      expect(response.json).toMatchObject({
        error: { code: -32602, data: { reason: 'invalid_request_state' } },
      });
    }
    expect(app.observations.map((observation) => observation.errorKind)).toEqual([
      'unexpected_input_response_key',
      'unexpected_input_response_key',
    ]);
    expect(app.calls()).toBe(0);
    expect(ledger.consumed.size).toBe(0);
  });

  it('bounds repeated dropped confirmation envelopes at the request-state round cap', async () => {
    const ledger = new TestConfirmationLedger();
    const app = setup(ledger);
    const handler = remember(app.handler);
    const capabilities = { elicitation: { form: {} } };
    const args = { days: 1, reason: 'care' };
    const first = resultOf(
      await modernRpc(
        handler,
        'tools/call',
        { name: 'book_leave', arguments: args },
        { clientCapabilities: capabilities },
      ),
    );
    let requestState = first.requestState;
    for (let id = 2; id <= 8; id += 1) {
      const reissued = resultOf(
        await confirmationRetry(
          handler,
          args,
          requestState,
          wrappedConfirmation(),
          id,
          capabilities,
        ),
      );
      expect(reissued.resultType).toBe('input_required');
      expect(reissued.requestState).not.toBe(requestState);
      requestState = reissued.requestState;
    }

    const capped = await confirmationRetry(
      handler,
      args,
      requestState,
      wrappedConfirmation(),
      9,
      capabilities,
    );
    expect(capped.json).toMatchObject({
      error: { code: -32602, data: { reason: 'invalid_request_state' } },
    });
    expect(app.calls()).toBe(0);
    expect(ledger.consumed.size).toBe(0);
    expect(app.observations).toHaveLength(8);
    expect(app.observations.at(-1)?.errorKind).toBe('request_state_verification_failed');
  });
});

function confirmationMessage(result: Record<string, unknown>): string {
  const requests = result.inputRequests;
  if (typeof requests !== 'object' || requests === null || Array.isArray(requests)) {
    throw new Error('missing confirmation requests');
  }
  const confirmation = (requests as Record<string, unknown>).__noodle_confirmation;
  if (typeof confirmation !== 'object' || confirmation === null || Array.isArray(confirmation)) {
    throw new Error('missing confirmation request');
  }
  const params = (confirmation as Record<string, unknown>).params;
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new Error('missing confirmation params');
  }
  const message = (params as Record<string, unknown>).message;
  if (typeof message !== 'string') throw new Error('missing confirmation message');
  return message;
}
