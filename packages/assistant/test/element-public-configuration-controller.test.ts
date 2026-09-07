import { describe, expect, it, vi } from 'vitest';
import { parseAssistantConfiguration } from '../src/assistant-configuration-schema.js';
import { AssistantElementPublicConfigurationController } from '../src/element-public-configuration-controller.js';

describe('AssistantElementPublicConfigurationController', () => {
  it('accepts the authored confirmation-details presentation setting', () => {
    expect(
      parseAssistantConfiguration({
        assistant: { behavior: { showConfirmationDetails: false } },
      }),
    ).toEqual({ assistant: { behavior: { showConfirmationDetails: false } } });
  });

  it('applies public configuration containing compiler-derived rgba border tokens', async () => {
    const configuration = {
      branding: {
        accent: '#FB5553',
        surface: '#FFFFFF',
        surfaceDark: '#1A1A1A',
        theme: {
          light: {
            border: 'rgba(16,20,23,0.13)',
            borderStrong: 'rgba(16,20,23,0.22)',
          },
          dark: {
            border: 'rgba(248,250,252,0.13)',
            borderStrong: 'rgba(248,250,252,0.22)',
          },
        },
      },
    };
    const apply = vi.fn();
    const loadingChanged = vi.fn();
    const controller = new AssistantElementPublicConfigurationController(
      () => ({
        embedId: 'pub_0000000000000000000000000',
        serviceUrl: 'https://cloud.example',
        fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ configuration })),
      }),
      apply,
      loadingChanged,
    );

    controller.connect();

    await vi.waitFor(() => expect(loadingChanged).toHaveBeenLastCalledWith(false));
    expect(apply).toHaveBeenCalledWith(configuration);
  });

  it('keeps the fallback appearance when the public configuration is malformed', async () => {
    const apply = vi.fn();
    const loadingChanged = vi.fn();
    const controller = new AssistantElementPublicConfigurationController(
      () => ({
        embedId: 'pub_0000000000000000000000000',
        serviceUrl: 'https://cloud.example',
        fetch: vi.fn<typeof fetch>().mockResolvedValue(
          Response.json({
            configuration: {
              branding: { name: 'Unvalidated name' },
              assistant: { layout: { position: 'top-left' } },
            },
          }),
        ),
      }),
      apply,
      loadingChanged,
    );

    controller.connect();

    await vi.waitFor(() => expect(loadingChanged).toHaveBeenLastCalledWith(false));
    expect(apply).not.toHaveBeenCalled();
  });

  it('rejects arbitrary CSS in a public theme token', async () => {
    const apply = vi.fn();
    const loadingChanged = vi.fn();
    const controller = new AssistantElementPublicConfigurationController(
      () => ({
        embedId: 'pub_0000000000000000000000000',
        serviceUrl: 'https://cloud.example',
        fetch: vi.fn<typeof fetch>().mockResolvedValue(
          Response.json({
            configuration: {
              branding: {
                theme: {
                  light: { border: 'url(https://attacker.example/color)' },
                },
              },
            },
          }),
        ),
      }),
      apply,
      loadingChanged,
    );

    controller.connect();

    await vi.waitFor(() => expect(loadingChanged).toHaveBeenLastCalledWith(false));
    expect(apply).not.toHaveBeenCalled();
  });

  it.each([
    ['border', 'rgba(256,20,23,0.13)'],
    ['border', 'rgba(16,20,23,1.1)'],
    ['border', 'var(--customer-color)'],
    ['text', 'rgba(16,20,23,0.13)'],
  ])('rejects the unsafe resolved %s color %s', (token, color) => {
    expect(
      parseAssistantConfiguration({
        branding: { theme: { light: { [token]: color } } },
      }),
    ).toBeUndefined();
  });
});
