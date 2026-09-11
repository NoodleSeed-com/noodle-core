import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { deploySuccessResponseSchema } from '../src/index.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../contract/v1/${name}.json`, import.meta.url), 'utf8'));

it('preserves the additive effective authentication field in the deploy response fixture', () => {
  const response = fixture('deploy-customer-response');
  expect(deploySuccessResponseSchema.parse(response)).toEqual(response);
});

it('keeps older deploy responses without an inferred authentication authority', () => {
  const response = fixture('deploy-response');
  expect(deploySuccessResponseSchema.parse(response)).toEqual(response);
  expect(deploySuccessResponseSchema.parse(response)).not.toHaveProperty('authentication');
});
