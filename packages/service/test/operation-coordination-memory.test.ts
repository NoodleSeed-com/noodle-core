import { InMemoryOperationCoordinationStore } from '../src/operation-coordination.js';
import { describeOperationCoordinationStore } from './operation-coordination-store-suite.js';

describeOperationCoordinationStore(async () => new InMemoryOperationCoordinationStore());
