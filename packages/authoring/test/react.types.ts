import { expectTypeOf } from 'vitest';
import type { FormProps, GeneratedReactHelpers } from '../src/react.js';

expectTypeOf<'action'>().not.toMatchTypeOf<keyof FormProps>();
expectTypeOf<'method'>().not.toMatchTypeOf<keyof FormProps>();
expectTypeOf<'target'>().not.toMatchTypeOf<keyof FormProps>();
expectTypeOf<FormProps['onSubmit']>().toEqualTypeOf<() => void | Promise<void>>();
expectTypeOf<GeneratedReactHelpers['useWidgetReady']>().toEqualTypeOf<() => boolean>();
