import { InMemoryOperationEvidenceStore } from '../src/operation-evidence-memory.js';
import { describeOperationEvidence } from './operation-evidence-suite.js';

describeOperationEvidence(async () => new InMemoryOperationEvidenceStore());
