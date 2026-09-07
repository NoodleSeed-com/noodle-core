import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  evaluateSemanticCase,
  mergeSemanticExpectations,
  parseSemanticSmokeArgs,
  runCase,
} from '../../../scripts/shopify-semantic-smoke.mjs';

describe('Shopify semantic smoke runner', () => {
  it('requires the live service and storefront origin and defaults the Noodle target', () => {
    expect(
      parseSemanticSmokeArgs([
        '--',
        '--service',
        'https://api.example',
        '--origin',
        'https://merchant.myshopify.com',
      ]),
    ).toMatchObject({
      service: 'https://api.example',
      origin: 'https://merchant.myshopify.com',
      org: 'noodleseed',
      app: 'shopify',
      env: 'dev',
    });
    expect(() => parseSemanticSmokeArgs(['--service', 'https://api.example'])).toThrow(/--origin/);
  });

  it('accepts bounded retrieval and one final recommendation view', () => {
    const summary = evaluateSemanticCase(
      {
        id: 'semantic_product',
        prompt: 'Find a beginner-friendly product for snowy hills.',
        expect: {
          requiredTools: ['search_products', 'show_product_recommendations'],
          allowedTools: ['search_products', 'show_product_recommendations'],
          maxToolCalls: 3,
          toolCallLimits: { search_products: 2, show_product_recommendations: 1 },
          requireViewTools: ['show_product_recommendations'],
          forbiddenTools: ['create_checkout'],
          expectedProductTitles: ['Beginner Snowboard'],
        },
      },
      [
        { event: 'tool_started', data: { id: '1', tool: 'search_products' } },
        { event: 'tool_started', data: { id: '2', tool: 'search_products' } },
        {
          event: 'tool_started',
          data: { id: '3', tool: 'show_product_recommendations' },
        },
        {
          event: 'view_available',
          data: {
            id: '3',
            tool: 'show_product_recommendations',
            result: { products: [{ title: 'Beginner Snowboard' }] },
          },
        },
        { event: 'content', data: { delta: 'Select Details to focus on one item.' } },
        { event: 'done', data: {} },
      ],
    );

    expect(summary).toEqual({
      id: 'semantic_product',
      ok: true,
      toolCalls: ['search_products', 'search_products', 'show_product_recommendations'],
      views: ['show_product_recommendations'],
      contentCharacters: 36,
      matchedProductTitles: ['Beginner Snowboard'],
    });
  });

  it('fails closed on repeated search, forbidden mutation, missing evidence, or model errors', () => {
    const testCase = {
      id: 'bounded',
      prompt: 'Find a product.',
      expect: {
        requiredTools: ['search_products'],
        allowedTools: ['search_products'],
        maxToolCalls: 2,
        toolCallLimits: { search_products: 2 },
        forbiddenTools: ['create_checkout'],
        contentIncludesAny: ['no matching'],
      },
    };
    expect(() =>
      evaluateSemanticCase(testCase, [
        { event: 'tool_started', data: { id: '1', tool: 'search_products' } },
        { event: 'tool_started', data: { id: '2', tool: 'search_products' } },
        { event: 'tool_started', data: { id: '3', tool: 'search_products' } },
      ]),
    ).toThrow(/at most 2/);
    expect(() =>
      evaluateSemanticCase(testCase, [
        { event: 'tool_started', data: { id: '1', tool: 'create_checkout' } },
      ]),
    ).toThrow(/forbidden tool/);
    expect(() =>
      evaluateSemanticCase(testCase, [
        { event: 'tool_started', data: { id: '1', tool: 'search_products' } },
        { event: 'content', data: { delta: 'Try something else.' } },
      ]),
    ).toThrow(/expected content evidence/);
    expect(() =>
      evaluateSemanticCase(testCase, [{ event: 'error', data: { code: 'step_limit' } }]),
    ).toThrow(/assistant error/);
  });

  it('merges uncommitted store-specific expectations by case id without changing prompts', () => {
    expect(
      mergeSemanticExpectations(
        {
          version: 1,
          cases: [
            {
              id: 'semantic_product',
              prompt: 'Find a product.',
              expect: { maxToolCalls: 3, forbiddenTools: ['create_checkout'] },
            },
          ],
        },
        {
          version: 1,
          cases: [
            {
              id: 'semantic_product',
              expect: { expectedProductTitles: ['Store-only title'] },
            },
          ],
        },
      ),
    ).toEqual({
      version: 1,
      cases: [
        {
          id: 'semantic_product',
          prompt: 'Find a product.',
          expect: {
            maxToolCalls: 3,
            forbiddenTools: ['create_checkout'],
            expectedProductTitles: ['Store-only title'],
          },
        },
      ],
    });
  });

  it('allows the contracted zero-result rewrite and bounds both remote requests', async () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL('../../../scripts/e2e/fixtures/shopify-semantic-cases.json', import.meta.url),
        'utf8',
      ),
    );
    const zeroResult = fixture.cases.find(
      (testCase: { id: string }) => testCase.id === 'exact_product_zero_result',
    );
    expect(zeroResult.expect).toMatchObject({
      maxToolCalls: 2,
      toolCallLimits: { search_products: 2 },
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: 'session-token',
            endpoints: { turns: 'https://api.example/v1/assistant/turns' },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(new Response('event: done\ndata: {}\n\n', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await runCase(
        { service: 'https://api.example', origin: 'https://merchant.myshopify.com' },
        { clientId: 'client', clientSecret: 'secret' },
        { id: 'bounded_remote', prompt: 'Answer generally.', expect: { maxToolCalls: 0 } },
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const [, init] of fetchMock.mock.calls) {
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(init.signal.aborted).toBe(false);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
