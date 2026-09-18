import { describe, expect, it, vi } from 'vitest';
import { requestModelCompletion } from '../src/model-request.js';

const binding = {
  source: 'operator' as const,
  baseUrl: 'https://models.example/v1',
  model: 'pinned-model',
  apiKey: 'secret',
};
describe('model inference guard', () => {
  it('refuses paid I/O before dispatch when a reservation is denied', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      requestModelCompletion({
        binding: {
          ...binding,
          inferenceGuard: {
            reserve: async () => {
              throw new Error('daily_spend_limit');
            },
          },
        },
        messages: [],
        tools: [],
        fetcher,
      }),
    ).rejects.toThrow('daily_spend_limit');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('releases only an undispatched reservation when sponsorship refuses the request', async () => {
    const cancelBeforeDispatch = vi.fn(async () => undefined);
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      requestModelCompletion({
        binding: {
          ...binding,
          source: 'noodle-managed',
          sponsorship: { accountKey: 'test', allowance: 1, units: 1, admit: async () => false },
          inferenceGuard: {
            reserve: async () => ({ settle: async () => undefined, cancelBeforeDispatch }),
          },
        },
        messages: [],
        tools: [],
        fetcher,
      }),
    ).rejects.toThrow();
    expect(cancelBeforeDispatch).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('settles reported reasoning usage and preserves an unknown maximum on transport failure', async () => {
    const settle = vi.fn(async () => undefined);
    const reserve = vi.fn(async () => ({ settle }));
    await requestModelCompletion({
      binding: { ...binding, inferenceGuard: { reserve } },
      messages: [],
      tools: [],
      fetcher: async () =>
        Response.json({
          choices: [{ message: { role: 'assistant', content: 'Hi' } }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 20,
            total_tokens: 35,
            completion_tokens_details: { reasoning_tokens: 5 },
          },
        }),
    });
    expect(settle).toHaveBeenCalledWith({
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 35,
      reasoningTokens: 5,
    });
    settle.mockClear();
    await expect(
      requestModelCompletion({
        binding: { ...binding, inferenceGuard: { reserve } },
        messages: [],
        tools: [],
        fetcher: async () => {
          throw new Error('timeout');
        },
      }),
    ).rejects.toThrow();
    expect(settle).not.toHaveBeenCalled();
  });
});
