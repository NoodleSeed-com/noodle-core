import { expectTypeOf } from 'vitest';
import type { ConnectorClient, Ref } from '../src/recording.js';

declare const api: ConnectorClient;
if (api.read) {
  const result = api.read({ id: 'example' });
  expectTypeOf(result.tasks).toEqualTypeOf<Ref | undefined>();
  expectTypeOf(result.task).toEqualTypeOf<Ref | undefined>();
  expectTypeOf(result.at(0)).toMatchTypeOf<Ref>();
}
