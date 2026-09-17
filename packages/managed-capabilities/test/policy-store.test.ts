import { describe } from 'vitest';
import { InMemoryCapabilityPolicyStore } from '../src/policy-store.js';
import { policyStoreConformance } from './policy-conformance.js';

describe('memory policy conformance', () =>
  policyStoreConformance(async () => new InMemoryCapabilityPolicyStore()));
