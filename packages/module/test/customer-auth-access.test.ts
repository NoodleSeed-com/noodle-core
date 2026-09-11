import { describe, expect, it } from 'vitest';
import { type AccessMode, usesCustomerAuthentication } from '../src/index.js';

interface CustomerAuthenticationCase {
  readonly name: string;
  readonly schemaVersion: number;
  readonly accessMode: AccessMode | undefined;
  readonly hasServerAuth: boolean;
  readonly expected: boolean;
}

const cases: readonly CustomerAuthenticationCase[] = [
  {
    name: 'customers mode with projected auth',
    schemaVersion: 1,
    accessMode: 'customers',
    hasServerAuth: true,
    expected: true,
  },
  {
    name: 'customers mode without projected auth',
    schemaVersion: 2,
    accessMode: 'customers',
    hasServerAuth: false,
    expected: true,
  },
  {
    name: 'version 2 mixed mode with projected auth',
    schemaVersion: 2,
    accessMode: 'mixed',
    hasServerAuth: true,
    expected: true,
  },
  {
    name: 'version 1 mixed mode with dormant auth',
    schemaVersion: 1,
    accessMode: 'mixed',
    hasServerAuth: true,
    expected: false,
  },
  {
    name: 'version 1 mixed mode without auth',
    schemaVersion: 1,
    accessMode: 'mixed',
    hasServerAuth: false,
    expected: false,
  },
  {
    name: 'version 2 mixed mode without projected auth',
    schemaVersion: 2,
    accessMode: 'mixed',
    hasServerAuth: false,
    expected: false,
  },
  {
    name: 'unknown-version mixed mode with projected auth',
    schemaVersion: 3,
    accessMode: 'mixed',
    hasServerAuth: true,
    expected: false,
  },
  {
    name: 'public mode',
    schemaVersion: 2,
    accessMode: 'public',
    hasServerAuth: true,
    expected: false,
  },
  {
    name: 'absent mode',
    schemaVersion: 2,
    accessMode: undefined,
    hasServerAuth: true,
    expected: false,
  },
];

describe('usesCustomerAuthentication', () => {
  it.each(cases)('$name -> $expected', ({ expected, name: _name, ...input }) => {
    expect(usesCustomerAuthentication(input)).toBe(expected);
  });
});
