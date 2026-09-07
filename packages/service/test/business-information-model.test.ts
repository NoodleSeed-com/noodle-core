import { describe, expect, it } from 'vitest';
import { permissionsForBusinessRole } from '../src/business-information/model.js';
import {
  MAX_PAYLOAD_BYTES,
  PayloadValidationError,
  validateManagedPayload,
} from '../src/business-information/validation.js';

describe('managed payload custody boundary', () => {
  it('accepts a bounded ordinary request', () => {
    expect(
      validateManagedPayload({
        request_type: 'refund',
        summary: 'Please review the fare difference.',
        booking_reference: 'ABC123',
      }),
    ).toEqual({
      request_type: 'refund',
      summary: 'Please review the fare difference.',
      booking_reference: 'ABC123',
    });
  });

  it.each([
    [{ card_number: '4242424242424242' }, 'prohibited_field'],
    [{ details: '4242 4242 4242 4242' }, 'payment_card_value'],
    [{ api_key: 'ordinary-looking' }, 'prohibited_field'],
    [{ details: 'Bearer secret-token' }, 'credential_value'],
    [{ national_id: 'A1234567' }, 'prohibited_field'],
    [{ details: '123-45-6789' }, 'government_id_value'],
    [{ biometric_template: 'encoded' }, 'prohibited_field'],
    [{ details: 'fingerprint template: encoded' }, 'health_biometric_value'],
  ])('rejects prohibited field or value content %#', (payload, code) => {
    expect(() => validateManagedPayload(payload)).toThrowError(expect.objectContaining({ code }));
  });

  it('bounds nesting, property count, strings, arrays, and encoded bytes', () => {
    expect(() =>
      validateManagedPayload({ a: { b: { c: { d: { e: { f: { g: true } } } } } } }),
    ).toThrow(PayloadValidationError);
    expect(() =>
      validateManagedPayload(
        Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`p${index}`, index])),
      ),
    ).toThrow(/properties/);
    expect(() => validateManagedPayload({ value: 'x'.repeat(4097) })).toThrow(/string/);
    expect(() => validateManagedPayload({ values: Array.from({ length: 51 }, () => 1) })).toThrow(
      /array/,
    );
    expect(() => validateManagedPayload({ value: 'x'.repeat(MAX_PAYLOAD_BYTES) })).toThrow(
      /bytes|string/,
    );
  });

  it('requires a JSON object with finite JSON values', () => {
    expect(() => validateManagedPayload(['not', 'an', 'object'])).toThrow(/object/);
    expect(() => validateManagedPayload({ value: Number.NaN })).toThrow(/finite/);
    expect(() => validateManagedPayload({ value: undefined })).toThrow(/JSON/);
  });
});

describe('business role permissions', () => {
  it('keeps destructive and administrative access with administrators', () => {
    expect(permissionsForBusinessRole('administrator')).toEqual(
      expect.arrayContaining(['installation:administer', 'grants:manage', 'records:delete']),
    );
    expect(permissionsForBusinessRole('manager')).toContain('records:export');
    expect(permissionsForBusinessRole('manager')).not.toContain('records:delete');
    expect(permissionsForBusinessRole('operator')).toContain('records:assign');
    expect(permissionsForBusinessRole('viewer')).toEqual(['records:read']);
  });
});
