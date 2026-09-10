import { validateJsonSchema } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { assertCompatibleManagedRelease } from '../src/business-information/managed-releases.js';
import { managedSolutionManifest } from '../src/business-information/managed-solution-executable.js';
import {
  builtInDefinition,
  builtInDefinitionAtRelease,
  validateProfilePayload,
} from '../src/business-information/profiles.js';

describe('managed request follow-up', () => {
  it.each([
    ['travel', 'travel_requests', 3, { request_type: 'service', summary: 'Please help.' }],
    [
      'restaurant',
      'guest_requests',
      2,
      { request_type: 'reservation_help', summary: 'Please help.' },
    ],
  ] as const)('collects a reply email in the %s agent without rewriting historical records', (key, collection, priorRelease, payload) => {
    const current = builtInDefinition(key);
    const previous = builtInDefinitionAtRelease(key, priorRelease);
    expect(() => assertCompatibleManagedRelease(previous, current)).not.toThrow();
    const oldCollection = previous.collections.find((entry) => entry.key === collection);
    const newCollection = current.collections.find((entry) => entry.key === collection);
    expect(newCollection?.schemaVersion).toBe((oldCollection?.schemaVersion ?? 0) + 1);
    expect(newCollection?.recordSchema.properties).toHaveProperty('contact_email.format', 'email');
    expect(validateJsonSchema(newCollection?.recordSchema, payload)).toEqual([]);
    expect(validateProfilePayload(key, collection, payload)).toEqual(payload);

    const manifest = managedSolutionManifest(current);
    const tools = manifest.tools as { inputSchema: Record<string, unknown> }[];
    const inputSchema = tools[0]?.inputSchema;
    expect(inputSchema?.required).toContain('contact_email');
    expect(validateJsonSchema(inputSchema, payload).length).toBeGreaterThan(0);
    expect(
      validateJsonSchema(inputSchema, { ...payload, contact_email: 'not-an-email' }).length,
    ).toBeGreaterThan(0);
    expect(
      validateJsonSchema(inputSchema, { ...payload, contact_email: 'guest@example.test' }),
    ).toEqual([]);
    expect(
      validateJsonSchema(inputSchema, {
        ...payload,
        contact_email: 'guest@example.test',
        status: 'resolved',
      }).length,
    ).toBeGreaterThan(0);
    expect(() =>
      validateProfilePayload(key, collection, { ...payload, contact_email: 'not-an-email' }),
    ).toThrow();

    const historical = managedSolutionManifest(previous).tools as {
      inputSchema: Record<string, unknown>;
    }[];
    expect(historical[0]?.inputSchema.required).not.toContain('contact_email');
    expect(oldCollection?.recordSchema.properties).not.toHaveProperty('contact_email');
  });
});
