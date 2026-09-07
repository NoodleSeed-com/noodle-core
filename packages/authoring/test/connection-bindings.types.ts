import { expectTypeOf } from 'vitest';
import {
  bind,
  type ConnectionSource,
  type ConnectorRef,
  connection,
  connector,
  externalExchange,
  managedSecret,
  secret,
  z,
} from '../src/index.js';

const mail = connector('mail')
  .version('1.0.0')
  .http({
    baseUrl: 'https://mail.example.com',
    credentialProfiles: {
      delegated: { kind: 'bearer' },
      service: { kind: 'bearer' },
    },
    operations: {
      search: {
        type: 'read',
        path: '/messages',
        input: z.object({}),
        output: z.object({}),
      },
    },
  });

type MailProfile = typeof mail extends ConnectorRef<infer Profile> ? Profile : never;
type MailBindingOptions = Parameters<typeof bind<MailProfile>>[1];
expectTypeOf<MailProfile>().toEqualTypeOf<'delegated' | 'service'>();
expectTypeOf<MailBindingOptions['profile']>().toEqualTypeOf<'delegated' | 'service'>();
expectTypeOf<'delegated'>().toMatchTypeOf<MailProfile>();
expectTypeOf<'delegtaed'>().not.toMatchTypeOf<MailProfile>();
expectTypeOf<'delegtaed'>().not.toMatchTypeOf<MailBindingOptions['profile']>();

const personal = connection('personal_mail', externalExchange());
expectTypeOf(bind(mail, { profile: 'delegated', connection: personal })).toMatchTypeOf<
  ConnectorRef<'delegated' | 'service'>
>();

type ForgedManagedSecret = {
  readonly kind: 'managedSecret';
  readonly secret: 'ACTUALSECRET';
};
type ConnectionSourceParameter = Parameters<typeof connection>[1];
expectTypeOf<ConnectionSourceParameter>().toEqualTypeOf<ConnectionSource>();
expectTypeOf<ForgedManagedSecret>().not.toMatchTypeOf<ConnectionSource>();
expectTypeOf<ForgedManagedSecret>().not.toMatchTypeOf<ConnectionSourceParameter>();
expectTypeOf(externalExchange()).toMatchTypeOf<ConnectionSource>();
expectTypeOf(managedSecret(secret('MAIL_API_KEY'))).toMatchTypeOf<ConnectionSource>();

const legacy = connector('legacy')
  .version('1.0.0')
  .operation('read', { type: 'read', input: z.object({}), output: z.object({}) });
expectTypeOf(legacy).toMatchTypeOf<ConnectorRef>();

const curated = connector('curated_mail')
  .version('1.0.0')
  .credentials({ user_oauth: { kind: 'bearer' } })
  .operation('search', { type: 'read', input: z.object({}), output: z.object({}) });
expectTypeOf(curated).toMatchTypeOf<ConnectorRef<'user_oauth'>>();
expectTypeOf(bind(curated, { profile: 'user_oauth', connection: personal })).toMatchTypeOf<
  ConnectorRef<'user_oauth'>
>();
// @ts-expect-error: curated refs must reject credential profile typos instead of widening to string
bind(curated, { profile: 'user_ouath', connection: personal });
