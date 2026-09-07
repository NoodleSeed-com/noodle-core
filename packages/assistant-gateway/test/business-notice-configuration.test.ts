import type { ArtifactServer } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { assistantAppearanceOverrideSchema } from '../src/assistant-appearance.js';
import {
  assistantConfigurationHasBusinessNotice,
  effectiveAssistantBrowserConfiguration,
} from '../src/assistant-configuration.js';
import { InMemoryAssistantAppearanceSettingsStore } from '../src/in-memory-assistant-appearance-store.js';

const notice = {
  displayName: 'Receiving Business',
  privacyUrl: 'https://recipient.example/privacy',
  supportUrl: 'mailto:help@recipient.example',
};
describe('installation-owned browser notice', () => {
  it.each([
    'public',
    'authenticated',
  ] as const)('projects current notice after all %s appearance overrides', async (surface) => {
    const tenant = { org: 'acme', app: 'sales', env: 'prod' };
    const appearance = new InMemoryAssistantAppearanceSettingsStore();
    await appearance.replace({
      tenant,
      expectedRevision: 0,
      updatedAt: new Date(),
      updatedBy: 'operator',
      override: {
        branding: { name: 'Unrelated appearance name' },
        assistant: {
          privacyUrl: 'https://unrelated.example/privacy',
          termsUrl: 'https://unrelated.example/terms',
        },
      },
    });
    const server = { branding: { name: 'Developer name', accent: '#123456' } } as ArtifactServer;
    const result = await effectiveAssistantBrowserConfiguration(
      server,
      tenant,
      appearance,
      surface,
      notice,
    );
    expect(result.effective).toMatchObject({
      branding: { name: notice.displayName, accent: '#123456' },
      assistant: { privacyUrl: notice.privacyUrl, termsUrl: 'https://unrelated.example/terms' },
    });
    expect(server.branding?.name).toBe('Developer name');
    expect(result.effective?.assistant?.labels?.welcomeMessage).toContain(
      `Information is shared with ${notice.displayName}.`,
    );
    expect(result.effective?.assistant?.labels?.welcomeMessage).toContain(
      `Support: ${notice.supportUrl}`,
    );
    expect(result.effective).not.toHaveProperty('businessNotice');
    expect(JSON.stringify(result.effective)).not.toContain('updatedBy');
  });
  it('preserves the full contact destination within the existing bounded welcome field', async () => {
    const server = {
      assistant: { labels: { welcomeMessage: 'x'.repeat(1000) } },
    } as ArtifactServer;
    const longNotice = {
      ...notice,
      displayName: 'N'.repeat(120),
      supportUrl: `https://support.example/${'a'.repeat(488)}`,
    };
    const result = await effectiveAssistantBrowserConfiguration(
      server,
      { org: 'a', app: 'b', env: 'c' },
      undefined,
      undefined,
      longNotice,
    );
    const welcome = result.effective?.assistant?.labels?.welcomeMessage;
    expect(welcome?.length).toBeLessThanOrEqual(1000);
    expect(welcome).toContain(longNotice.supportUrl);
    expect(welcome).toContain('xxx');
  });
  it('does not make the receiving business an editable appearance field or invent one for an uninstalled app', async () => {
    expect(assistantAppearanceOverrideSchema.safeParse({ businessNotice: notice }).success).toBe(
      false,
    );
    const result = await effectiveAssistantBrowserConfiguration(
      { branding: { name: 'Standalone' } } as ArtifactServer,
      { org: 'a', app: 'b', env: 'c' },
      undefined,
    );
    expect(result.effective).toEqual({ branding: { name: 'Standalone' } });
  });
  it('refuses a session with missing or stale visible notice after an operator changes it', async () => {
    const projected = await effectiveAssistantBrowserConfiguration(
      {} as ArtifactServer,
      { org: 'a', app: 'b', env: 'c' },
      undefined,
      undefined,
      notice,
    );
    expect(assistantConfigurationHasBusinessNotice(projected.effective, notice)).toBe(true);
    expect(assistantConfigurationHasBusinessNotice(undefined, notice)).toBe(false);
    for (const next of [
      { ...notice, displayName: 'New recipient' },
      { ...notice, privacyUrl: 'https://new.example/privacy' },
      { ...notice, supportUrl: 'mailto:new@example.com' },
      { ...notice, supportUrl: notice.supportUrl.slice(0, -1) },
    ])
      expect(assistantConfigurationHasBusinessNotice(projected.effective, next)).toBe(false);
  });
});
