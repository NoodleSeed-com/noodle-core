import { compileManifest } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { server, tool, widgetResult } from '../src/index.js';

const HTML = '<!doctype html><main>Ticket</main>';

describe('tool-linked view manifest emission', () => {
  it('provides a typed helper for model-visible output plus widget-only metadata', () => {
    expect(
      widgetResult({
        visible: { ok: true, deploymentId: 'deploy_1' },
        meta: { noodle: { app: { confirmToken: 'capability-token' } } },
      }),
    ).toEqual({
      ok: true,
      deploymentId: 'deploy_1',
      __noodleResultMeta: { noodle: { app: { confirmToken: 'capability-token' } } },
    });
  });

  it('emits a widget into the manifest widgets block', async () => {
    const app = server('support_desk', { title: 'Support', version: '1.0.0' }, [
      tool('open_ticket', {
        description: 'Open a ticket.',
        input: { type: 'object' },
        output: { type: 'object', properties: { ok: { type: 'string' } }, required: ['ok'] },
        fulfil: () => ({ ok: 'yes' }),
        viewName: 'ticket_card',
        viewTitle: 'Support ticket',
        view: { html: HTML },
        csp: { connectDomains: ['https://api.example.com'] },
        permissions: { clipboardWrite: {} },
      }),
    ]);

    const manifest = await app.toManifest();
    expect(manifest.widgets).toEqual([
      {
        name: 'ticket_card',
        tool: 'open_ticket',
        title: 'Support ticket',
        html: HTML,
        csp: { connectDomains: ['https://api.example.com'] },
        permissions: { clipboardWrite: {} },
      },
    ]);
  });

  it('compiles author→manifest→artifact: ui:// resource emitted + tool _meta linked', async () => {
    const app = server('support_desk', { title: 'Support', version: '1.0.0' }, [
      tool('open_ticket', {
        description: 'Open a ticket.',
        input: { type: 'object' },
        fulfil: () => ({ ok: 'yes' }),
        viewName: 'ticket_card',
        view: { html: HTML },
      }),
    ]);

    const manifest = await app.toManifest();
    const result = compileManifest(manifest);
    expect(result.ok, result.ok ? '' : JSON.stringify(result.errors)).toBe(true);
    if (!result.ok) return;

    const widgetResource = result.artifact.resources?.find((r) => r.name === 'ticket_card');
    expect(widgetResource?.uri).toBe('ui://support_desk/ticket_card');
    expect(widgetResource?.mimeType).toBe('text/html;profile=mcp-app');

    const toolArtifact = result.artifact.tools.find((t) => t.name === 'open_ticket');
    expect(toolArtifact?._meta).toEqual({
      ui: { resourceUri: 'ui://support_desk/ticket_card' },
      'openai/outputTemplate': 'ui://support_desk/ticket_card',
    });
  });

  it('threads ChatGPT invocation + widget-description metadata from tool to the artifact', async () => {
    const app = server('support_desk', { title: 'Support', version: '1.0.0' }, [
      tool('open_ticket', {
        description: 'Open a support ticket and render it in a widget.',
        input: { type: 'object' },
        output: { type: 'object', properties: { ok: { type: 'string' } }, required: ['ok'] },
        fulfil: () => ({ ok: 'yes' }),
        viewTitle: 'Ticket card',
        viewDescription: 'A ticket detail widget for ChatGPT review.',
        view: { component: 'TicketCard', entry: './views/TicketCard.tsx' },
        invoking: 'Opening the ticket…',
        invoked: 'Ticket ready',
        csp: { connectDomains: ['https://api.example.com'] },
        domain: 'https://tickets.example.com',
      }),
    ]);

    const manifest = await app.toManifest();
    expect(manifest.widgets?.[0]).toMatchObject({
      name: 'open_ticket_widget',
      tool: 'open_ticket',
      description: 'A ticket detail widget for ChatGPT review.',
      domain: 'https://tickets.example.com',
      invoking: 'Opening the ticket…',
      invoked: 'Ticket ready',
    });

    const result = compileManifest(manifest);
    expect(result.ok, result.ok ? '' : JSON.stringify(result.errors)).toBe(true);
    if (!result.ok) return;

    // Invocation status copy rides the widget-opening tool's `_meta` (ChatGPT reads it there).
    const toolArtifact = result.artifact.tools.find((t) => t.name === 'open_ticket');
    expect(toolArtifact?._meta?.['openai/toolInvocation/invoking']).toBe('Opening the ticket…');
    expect(toolArtifact?._meta?.['openai/toolInvocation/invoked']).toBe('Ticket ready');

    // The widget description is emitted as the ChatGPT compat alias on the widget resource `_meta`.
    const widgetResource = result.artifact.resources?.find((r) => r.name === 'open_ticket_widget');
    expect(widgetResource?._meta?.['openai/widgetDescription']).toBe(
      'A ticket detail widget for ChatGPT review.',
    );
  });

  it('emits and compiles a React view widget', async () => {
    const app = server('support_desk', { title: 'Support', version: '1.0.0' }, [
      tool('open_ticket', {
        description: 'Open a ticket.',
        input: { type: 'object' },
        fulfil: () => ({ ok: 'yes' }),
        viewName: 'ticket_card',
        view: { component: 'TicketCard', entry: './views/TicketCard.tsx' },
      }),
    ]);

    const manifest = await app.toManifest();
    expect(manifest.widgets?.[0]).toMatchObject({
      name: 'ticket_card',
      tool: 'open_ticket',
      view: { component: 'TicketCard', entry: './views/TicketCard.tsx' },
    });

    const result = compileManifest(manifest);
    expect(result.ok, result.ok ? '' : JSON.stringify(result.errors)).toBe(true);
    if (!result.ok) return;
    const widgetResource = result.artifact.resources?.find((r) => r.name === 'ticket_card');
    const value = (widgetResource?.fulfilment as { output?: { value?: { value?: string } } }).output
      ?.value?.value;
    expect(value).toContain('data-noodle-react-view="TicketCard"');
  });

  it('omits the widgets block when none are declared', async () => {
    const app = server('plain', { title: 'Plain', version: '1.0.0' }, [
      tool('noop', {
        description: 'No-op.',
        input: { type: 'object' },
        fulfil: () => ({ ok: 'yes' }),
      }),
    ]);
    const manifest = await app.toManifest();
    expect(manifest.widgets).toBeUndefined();
  });
});
