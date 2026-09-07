import { describe, expect, it, vi } from 'vitest';
import { requestAssistantSuggestedPrompts } from '../src/assistant-suggestions.js';
import type { ResolvedAssistantModel } from '../src/model-request.js';

const binding: ResolvedAssistantModel = {
  source: 'operator',
  baseUrl: 'https://models.example/v1',
  model: 'test-model',
  apiKey: 'test-key',
};
const prompts = ['Compare the options', 'Show an example'];
const messages = [
  { role: 'user' as const, content: 'How can I get started?' },
  { role: 'assistant' as const, content: 'Start with one workflow.' },
];

describe('assistant suggestion generation', () => {
  it.each([
    'chat-completions',
    'responses',
  ] as const)('requests machine-readable suggestions over %s', async (transport) => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      const format = request.response_format ?? request.text?.format;
      // Compatible providers otherwise commonly wrap a JSON example in Markdown.
      const content =
        format?.type === 'json_object'
          ? JSON.stringify({ prompts })
          : `\`\`\`json\n${JSON.stringify({ prompts })}\n\`\`\``;
      return Response.json(
        transport === 'responses'
          ? {
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: content }],
                },
              ],
            }
          : { choices: [{ message: { role: 'assistant', content } }] },
      );
    });

    expect(
      await requestAssistantSuggestedPrompts({ ...binding, transport }, messages, fetcher),
    ).toEqual(prompts);
    expect(fetcher).toHaveBeenCalledOnce();
    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(request.tools).toEqual([]);
    expect(request.tool_choice).toBe('none');
  });

  it('allows a normal delayed provider response without the former two-second cutoff', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () =>
              resolve(
                Response.json({
                  choices: [
                    { message: { role: 'assistant', content: JSON.stringify({ prompts }) } },
                  ],
                }),
              ),
            2_100,
          );
          init?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(init.signal?.reason);
            },
            { once: true },
          );
        }),
    );
    expect(await requestAssistantSuggestedPrompts(binding, messages, fetcher)).toEqual(prompts);
  });

  it('keeps the operator completion ceiling and spends no request after the turn budget is exhausted', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        choices: [{ message: { role: 'assistant', content: JSON.stringify({ prompts }) } }],
      }),
    );
    await requestAssistantSuggestedPrompts(
      { ...binding, requestPolicy: { maxCompletionTokens: 80 } },
      messages,
      fetcher,
      undefined,
      100,
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).max_completion_tokens).toBe(80);
    expect(
      await requestAssistantSuggestedPrompts(binding, messages, fetcher, undefined, 0),
    ).toEqual([]);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
