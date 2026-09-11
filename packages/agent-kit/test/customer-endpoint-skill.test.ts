import { describe, expect, it } from 'vitest';
import { renderAgentFiles } from '../src/index.js';

function authoringReference(): string {
  const file = renderAgentFiles({}).find((candidate) =>
    candidate.path.endsWith('/references/authoring-workflow.md'),
  );
  expect(file, 'missing authoring workflow reference').toBeDefined();
  return file?.content ?? '';
}

describe('customer endpoint authoring guidance', () => {
  it('teaches the exclusive routed-connector auth boundary', () => {
    const authoring = authoringReference();

    expect(authoring).toContain(
      'Customer-routed connector auth must be omitted or use `delegatedTokenExchange` at both connector and operation level.',
    );
    expect(authoring).toContain(
      'The compiler validates the concrete connector definition emitted from TypeScript',
    );
    expect(authoring).toContain('use operation fakes while leaving auth declarative');
  });

  it('teaches confirmed routed actions and safe runtime failure', () => {
    const authoring = authoringReference();

    expect(authoring).toContain('Auth-derived customer API endpoints');
    expect(authoring).toContain('annotations.openAction({ destructive: false, confirm: true })');
    expect(authoring).toContain("server.interactions.confirmationFallback: 'host'");
    expect(authoring).toContain('trusts the MCP host to have collected native write approval');
    expect(authoring).toContain('interaction_unavailable');
    expect(authoring).toContain('customer_endpoint_action_unsupported');
    expect(authoring).toContain('customer_endpoint_surface_unsupported');
    expect(authoring).toContain('connector_route_unavailable');
    expect(authoring).toContain('invalid_continuation');
    expect(authoring).toContain('private server-held continuation');
    expect(authoring).toContain('before credential lookup or connector egress');
    expect(authoring).toContain('`tools/list` follows the scope/role discovery rule');
    expect(authoring).toContain('explicit public-descriptor opt-in');
    expect(authoring).toContain(
      'route availability neither reveals tenant topology nor changes execution authorization',
    );
  });

  it('keeps route authority URL-blind across delegated exchange and assistant sessions', () => {
    const authoring = authoringReference();

    expect(authoring).toContain('route: { key, fingerprint }');
    expect(authoring).toContain('cache and single-flight keys include that route binding');
    expect(authoring).toContain('never the customer URL');
    expect(authoring).toContain('Embedded-assistant sessions can bind customer-routed connectors');
    expect(authoring).toContain(
      'authenticated embedding backend resolves each route from server-owned tenancy data',
    );
    expect(authoring).toContain('Browser input, page context, session claims, and tool arguments');
  });
});
