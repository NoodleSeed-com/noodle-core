import { describe, expect, it } from 'vitest';
import app from '../src/server.js';

describe('credit-union example', () => {
  it('exports a Noodle server definition', () => {
    expect(typeof app.toManifest).toBe('function');
  });

  it('emits a refinance finder app manifest with app-only helpers and workspace state', async () => {
    const manifest = (await app.toManifest()) as {
      server: { name: string };
      handoff?: { allowedDomains?: string[] };
      state?: { handles?: Record<string, { kind: string; scope: string }> };
      connectors?: Record<string, { id: string; version: string }>;
      tools: Array<{
        name: string;
        visibility?: string[];
        output?: unknown;
      }>;
      widgets?: Array<{
        name: string;
        tool: string;
        view?: { component?: string; entry?: string };
      }>;
    };

    expect(manifest.server.name).toBe('credit_union');
    expect(manifest.state?.handles?.refi_workspace).toMatchObject({
      kind: 'workflow',
      scope: 'caller',
    });
    expect(manifest.handoff?.allowedDomains).toEqual(['https://creditunion.example.com']);
    expect(manifest.connectors?.state).toEqual({ id: 'noodle_state', version: '1.0.0' });

    const tools = new Map(manifest.tools.map((tool) => [tool.name, tool]));
    expect(
      manifest.widgets?.find((widget) => widget.tool === 'open_refinance_finder')?.view,
    ).toMatchObject({
      component: 'refinance-dashboard',
      entry: './views/refinance-dashboard.tsx',
    });
    for (const helper of [
      'list_members',
      'detect_recurring_auto_loans',
      'estimate_refinance_offer',
      'sync_refi_workspace',
    ]) {
      expect(tools.get(helper)?.visibility).toEqual(['app']);
    }
    expect(JSON.stringify(tools.get('open_refinance_finder'))).toContain('refinanceOffers');
    expect(JSON.stringify(tools.get('summarize_refinance_opportunities'))).toContain(
      'recurringPayments',
    );
  });
});
