import { describe, expect, it } from 'vitest';
import { isValidName, parseOperationRef } from '../src/manifest/naming.js';

describe('manifest naming rules', () => {
  describe('isValidName', () => {
    it('accepts lowercase letters, numbers, and underscores', () => {
      expect(isValidName('acme_orders')).toBe(true);
      expect(isValidName('acme123')).toBe(true);
      expect(isValidName('orders')).toBe(true);
    });

    it('rejects uppercase letters', () => {
      expect(isValidName('Acme')).toBe(false);
      expect(isValidName('ACME_ORDERS')).toBe(false);
    });

    it('rejects special characters and spaces', () => {
      expect(isValidName('acme-orders')).toBe(false);
      expect(isValidName('acme orders')).toBe(false);
      expect(isValidName('acme.orders')).toBe(false);
      expect(isValidName('acme/orders')).toBe(false);
    });

    it('rejects empty strings', () => {
      expect(isValidName('')).toBe(false);
    });
  });

  describe('parseOperationRef', () => {
    it('splits a valid connector.operation reference', () => {
      expect(parseOperationRef('acme.get_order')).toEqual({
        connector: 'acme',
        operation: 'get_order',
      });
      expect(parseOperationRef('a.b')).toEqual({
        connector: 'a',
        operation: 'b',
      });
    });

    it('returns null on invalid operation reference patterns', () => {
      expect(parseOperationRef('acme')).toBeNull();
      expect(parseOperationRef('acme.')).toBeNull();
      expect(parseOperationRef('.get_order')).toBeNull();
      expect(parseOperationRef('acme..get_order')).toBeNull();
      expect(parseOperationRef('acme.get-order')).toBeNull();
      expect(parseOperationRef('Acme.get_order')).toBeNull();
      expect(parseOperationRef('acme.Get_order')).toBeNull();
    });
  });
});
