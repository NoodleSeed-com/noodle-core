import { describe, expect, it } from 'vitest';
import {
  assistantAppearanceOverrideSchema,
  resolveAssistantAppearanceConfiguration,
} from '../src/assistant-appearance.js';

describe('assistant appearance configuration', () => {
  it('leaves the renderer on the Halo baseline when neither source declares appearance', () => {
    expect(resolveAssistantAppearanceConfiguration(undefined, undefined)).toEqual({
      effective: undefined,
      fallback: 'halo',
      provenance: {},
    });
  });

  it('deep-merges an operator override above developer-authored configuration', () => {
    const developer = assistantAppearanceOverrideSchema.parse({
      branding: {
        name: 'Acme Support',
        accent: '#2563EB',
        theme: { light: { text: '#101828', border: '#D0D5DD' } },
      },
      assistant: {
        theme: 'auto',
        layout: { position: 'bottom-left', panelWidth: 640 },
        behavior: { showConfirmationDetails: false },
        presentation: {
          launcher: { style: 'pill', icon: 'brand-mark' },
          panel: { surface: 'solid' },
        },
        suggestedPrompts: ['How can you help?'],
      },
    });
    const operator = assistantAppearanceOverrideSchema.parse({
      branding: {
        accent: '#EA580C',
        theme: { light: { border: '#FED7AA' } },
      },
      assistant: {
        theme: 'dark',
        layout: { position: 'bottom-right' },
        behavior: { showConfirmationDetails: true },
        presentation: { launcher: { style: 'bubble' } },
        suggestedPrompts: ['Track my order'],
      },
    });

    expect(resolveAssistantAppearanceConfiguration(developer, operator)).toEqual({
      fallback: 'halo',
      effective: {
        branding: {
          name: 'Acme Support',
          accent: '#EA580C',
          theme: { light: { text: '#101828', border: '#FED7AA' } },
        },
        assistant: {
          theme: 'dark',
          layout: { position: 'bottom-right', panelWidth: 640 },
          behavior: { showConfirmationDetails: true },
          presentation: {
            launcher: { style: 'bubble', icon: 'brand-mark' },
            panel: { surface: 'solid' },
          },
          suggestedPrompts: ['Track my order'],
        },
      },
      provenance: {
        'assistant.behavior.showConfirmationDetails': 'operator',
        'assistant.layout.panelWidth': 'developer',
        'assistant.layout.position': 'operator',
        'assistant.presentation.launcher.icon': 'developer',
        'assistant.presentation.launcher.style': 'operator',
        'assistant.presentation.panel.surface': 'developer',
        'assistant.suggestedPrompts': 'operator',
        'assistant.theme': 'operator',
        'branding.accent': 'operator',
        'branding.name': 'developer',
        'branding.theme.light.border': 'operator',
        'branding.theme.light.text': 'developer',
      },
    });
  });

  it('accepts only renderer-owned browser configuration', () => {
    expect(
      assistantAppearanceOverrideSchema.safeParse({
        branding: {
          logo: {
            uri: 'https://assets.example.com/logo.png',
            darkUri: 'https://assets.example.com/logo-dark.png',
            alt: 'Acme',
          },
          surface: '#F8F8F8',
          surfaceDark: '#0C0A09',
        },
        assistant: {
          theme: 'auto',
          layout: { position: 'bottom-center' },
          behavior: { showConfirmationDetails: false },
          presentation: { launcher: { style: 'bubble' } },
        },
      }).success,
    ).toBe(true);

    for (const unsafe of [
      { assistant: { model: { apiKey: 'secret' } } },
      { assistant: { capabilities: [{ kind: 'tool', name: 'admin' }] } },
      { assistant: { html: '<script>alert(1)</script>' } },
      { branding: { accent: 'green' } },
      { branding: { logo: { uri: 'javascript:alert(1)', alt: 'Bad' } } },
      { assistant: { layout: { panelWidth: 20_000 } } },
    ]) {
      expect(assistantAppearanceOverrideSchema.safeParse(unsafe).success).toBe(false);
    }
  });

  it('allows loopback logo URLs for local testing but refuses ordinary insecure origins', () => {
    expect(
      assistantAppearanceOverrideSchema.safeParse({
        branding: { logo: { uri: 'http://127.0.0.1:4200/logo.png', alt: 'Local logo' } },
      }).success,
    ).toBe(true);
    expect(
      assistantAppearanceOverrideSchema.safeParse({
        branding: { logo: { uri: 'http://assets.example.com/logo.png', alt: 'Insecure logo' } },
      }).success,
    ).toBe(false);
  });
});
