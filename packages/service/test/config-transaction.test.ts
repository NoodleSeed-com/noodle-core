import { InMemoryConfigStore } from '../src/store/config-values.js';
import { describeConfigTransactions } from './config-transaction-suite.js';

describeConfigTransactions(
  'memory configuration transactions',
  async () => new InMemoryConfigStore(),
);
