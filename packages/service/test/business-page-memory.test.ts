import { describe } from 'vitest';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';
import { InMemoryBusinessWorkspaceBackend } from '../src/business-workspaces/memory.js';
import { businessPageConformance } from './business-page-conformance.js';
import { businessWorkspaceAdminConformance } from './business-workspace-admin-suite.js';

describe('hosted business pages (memory, development only)', () => {
  businessPageConformance(async () => new InMemoryBusinessInformationStore());
  businessWorkspaceAdminConformance(async () => ({
    business: new InMemoryBusinessInformationStore(),
    backend: new InMemoryBusinessWorkspaceBackend(),
  }));
});
