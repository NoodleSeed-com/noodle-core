// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAssistantConfiguration } from '../src/assistant-configuration-schema.js';
import { NoodleAssistantElement } from '../src/index.js';

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
describe('receiving-business notice through existing widget fields', () => {
  it('uses the unchanged strict browser schema and renders recipient/support as literal text before intake', async () => {
    const configuration = {
      branding: { name: 'Acme <img src=x>' },
      assistant: {
        privacyUrl: 'https://acme.example/privacy',
        behavior: { showHeader: false, showPoweredBy: false },
        labels: {
          welcomeMessage:
            'Information is shared with Acme <img src=x>. Support: mailto:help@acme.example\n\nHow can we help?',
        },
      },
    };
    expect(parseAssistantConfiguration(configuration)).toEqual(configuration);
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          token: 'token',
          expiresAt: '2030-01-01T00:00:00Z',
          endpoints: { turns: '/turns', toolConfirmations: '/confirm' },
          configuration,
        }),
      ),
    );
    const element = new NoodleAssistantElement();
    element.sessionEndpoint = '/session';
    document.body.append(element);
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelector('.empty-state')?.textContent).toContain(
        'Information is shared with Acme <img src=x>. Support: mailto:help@acme.example',
      ),
    );
    const send = vi.spyOn(element, 'sendMessage').mockResolvedValue();
    const trigger = element.shadowRoot?.querySelector<HTMLButtonElement>('.launcher-trigger');
    trigger?.click();
    expect(element.hasAttribute('open')).toBe(true);
    expect(element.hasAttribute('launcher-expanded')).toBe(false);
    expect(trigger?.getAttribute('aria-controls')).toBe('assistant-panel');
    expect(element.shadowRoot?.querySelector('.panel')?.getAttribute('aria-hidden')).toBe('false');
    expect(element.hasAttribute('has-messages')).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(element.shadowRoot?.querySelector('.empty-state img')).toBeNull();
    expect(element.shadowRoot?.querySelector<HTMLAnchorElement>('.legal a')?.href).toBe(
      configuration.assistant.privacyUrl,
    );
    expect(element.shadowRoot?.querySelector('.empty-state')?.textContent).toContain(
      'How can we help?',
    );
  });
  it.each([
    { privacyUrl: 'https://acme.example/privacy' },
    { termsUrl: 'https://acme.example/terms' },
    { labels: { welcomeMessage: 'Before you start, review this information.' } },
  ])('opens the panel before accepting input when introductory content is configured: %j', async (assistant) => {
    const element = new NoodleAssistantElement();
    element.sessionEndpoint = '/session';
    element.fetch = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        token: 'token',
        expiresAt: '2030-01-01T00:00:00Z',
        endpoints: { turns: '/turns', toolConfirmations: '/confirm' },
        configuration: { assistant },
      }),
    );
    document.body.append(element);
    await vi.waitFor(() => expect(element.hasAttribute('data-presentation-ready')).toBe(true));
    element.shadowRoot?.querySelector<HTMLButtonElement>('.launcher-trigger')?.click();
    expect(element.hasAttribute('open')).toBe(true);
    expect(element.hasAttribute('launcher-expanded')).toBe(false);
  });

  it('does not accept a first message before delayed introductory configuration is resolved', () => {
    const element = new NoodleAssistantElement();
    element.sessionEndpoint = '/session';
    element.fetch = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    document.body.append(element);
    element.shadowRoot?.querySelector<HTMLButtonElement>('.launcher-trigger')?.click();
    expect(element.hasAttribute('open')).toBe(true);
    expect(element.hasAttribute('launcher-expanded')).toBe(false);
    expect(element.shadowRoot?.querySelector('.panel')?.getAttribute('aria-hidden')).toBe('true');
  });
});
