import {
  invocationContextSystemMessage,
  resolveInvocationContext,
} from '@noodle-borg/assistant-gateway';
import type { RuntimeArtifact } from '@noodle-borg/compiler';
import type { ExecuteDeps } from '@noodle-borg/runtime';
import { describe, expect, it } from 'vitest';
import { createMcpInvocationContextResolver } from '../src/invocation-context.js';

describe('assistant invocation context', () => {
  it('derives a server-authoritative local snapshot from the current client timezone', () => {
    const context = resolveInvocationContext({
      instant: new Date('2026-07-14T04:30:00.000Z'),
      clientHint: { locale: 'en-PK', timeZone: 'Asia/Karachi' },
    });

    expect(context).toEqual({
      temporal: {
        instant: '2026-07-14T04:30:00.000Z',
        localDate: '2026-07-14',
        localTime: '09:30:00',
        utcOffset: '+05:00',
        weekday: 'Tuesday',
        timeZone: 'Asia/Karachi',
        locale: 'en-PK',
        source: { locale: 'client-hint', timeZone: 'client-hint' },
      },
      ambientStatus: 'not_configured',
    });
  });

  it('uses application preference, then client hint, server default, and platform fallback', () => {
    expect(
      resolveInvocationContext({
        instant: new Date('2026-07-14T04:30:00.000Z'),
        applicationPreference: { locale: 'fr-FR', timeZone: 'Europe/Paris' },
        clientHint: { locale: 'en-US', timeZone: 'America/New_York' },
        defaults: { locale: 'de-DE', timeZone: 'Europe/Berlin' },
      }).temporal,
    ).toMatchObject({
      locale: 'fr-FR',
      timeZone: 'Europe/Paris',
      source: { locale: 'user-preference', timeZone: 'user-preference' },
    });

    expect(
      resolveInvocationContext({
        instant: new Date('2026-07-14T04:30:00.000Z'),
        clientHint: { locale: 'not a locale', timeZone: 'not/a-zone' },
        defaults: { locale: 'de-DE', timeZone: 'Europe/Berlin' },
      }).temporal,
    ).toMatchObject({
      locale: 'de-DE',
      timeZone: 'Europe/Berlin',
      source: { locale: 'server-default', timeZone: 'server-default' },
    });

    expect(
      resolveInvocationContext({ instant: new Date('2026-07-14T04:30:00.000Z') }).temporal,
    ).toMatchObject({
      locale: 'en-US',
      timeZone: 'UTC',
      source: { locale: 'platform-default', timeZone: 'platform-default' },
    });
  });

  it('recomputes midnight and daylight-saving offsets from the turn instant', () => {
    expect(
      resolveInvocationContext({
        instant: new Date('2026-07-14T20:30:00.000Z'),
        clientHint: { timeZone: 'Asia/Karachi' },
      }).temporal.localDate,
    ).toBe('2026-07-15');

    const winter = resolveInvocationContext({
      instant: new Date('2026-01-15T12:00:00.000Z'),
      clientHint: { timeZone: 'America/New_York' },
    });
    const summer = resolveInvocationContext({
      instant: new Date('2026-07-15T12:00:00.000Z'),
      clientHint: { timeZone: 'America/New_York' },
    });
    expect(winter.temporal.utcOffset).toBe('-05:00');
    expect(summer.temporal.utcOffset).toBe('-04:00');
  });

  it('formats one deterministic model message without treating context as instructions', () => {
    const context = resolveInvocationContext({
      instant: new Date('2026-07-14T04:30:00.000Z'),
      clientHint: { locale: 'en-PK', timeZone: 'Asia/Karachi' },
    });
    expect(invocationContextSystemMessage(context)).toBe(
      'Current server time: 2026-07-14T04:30:00.000Z. User-local date and time: ' +
        '2026-07-14 09:30:00 +05:00 (Tuesday, Asia/Karachi; locale en-PK).',
    );
  });

  it('uses first-class verified caller preferences for authenticated MCP requests', async () => {
    const resolve = createMcpInvocationContextResolver(() => new Date('2026-07-14T04:30:00.000Z'));
    const context = await resolve({
      target: {
        artifact: {
          server: { context: { defaults: { locale: 'en-US', timeZone: 'UTC' } } },
        } as RuntimeArtifact,
        deps: {} as ExecuteDeps,
      },
      caller: {
        subject: 'customer-1',
        locale: 'ur-PK',
        timeZone: 'Asia/Karachi',
      },
    });

    expect(context?.temporal).toMatchObject({
      localDate: '2026-07-14',
      localTime: '09:30:00',
      locale: 'ur-PK',
      timeZone: 'Asia/Karachi',
      source: { locale: 'user-preference', timeZone: 'user-preference' },
    });
  });

  it('projects a validated per-call client location hint without overriding verified preferences', async () => {
    const resolve = createMcpInvocationContextResolver(() => new Date('2026-07-14T04:30:00.000Z'));
    const context = await resolve({
      target: {
        artifact: {
          server: { context: { defaults: { locale: 'en-US', timeZone: 'UTC' } } },
        } as RuntimeArtifact,
        deps: {} as ExecuteDeps,
      },
      caller: {
        subject: 'customer-1',
        timeZone: 'Asia/Karachi',
      },
      clientHint: {
        location: {
          latitude: 43.6532,
          longitude: -79.3832,
          city: 'Toronto',
          region: 'Ontario',
          country: 'CA',
          timeZone: 'America/Toronto',
        },
      },
    });

    expect(context).toMatchObject({
      temporal: {
        timeZone: 'Asia/Karachi',
        source: { timeZone: 'user-preference' },
      },
      location: {
        latitude: 43.6532,
        longitude: -79.3832,
        city: 'Toronto',
        region: 'Ontario',
        country: 'CA',
        timeZone: 'America/Toronto',
        source: 'client-hint',
      },
    });
  });
});
