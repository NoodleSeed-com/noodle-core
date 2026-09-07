import { describe, expect, it } from 'vitest';
import {
  calendarAdapterReleaseConfig,
  cloudRunCalendarArgs,
  cloudRunSecretArgs,
  parseCloudRunDescription,
} from '../../../scripts/system-release-runtime-config.mjs';

const input = {
  CALENDAR_ADAPTER_KEY_SECRET: 'calendar-key',
  CALENDAR_ADAPTER_KEY_VERSION: '2',
  CALENDAR_ADAPTER_DATABASE_URL_SECRET: 'calendar-db',
  CALENDAR_ADAPTER_DATABASE_URL_VERSION: '3',
  CALENDAR_ADAPTER_INSTANCE_CONNECTION_NAME: 'example-project:us-central1:example-instance',
  CALENDAR_ADAPTER_SERVICE_ACCOUNT: 'calendar@example.iam.gserviceaccount.com',
};
describe('Calendar adapter immutable release composition', () => {
  it('pins secret versions and a dedicated database identity, restoring the prior bindings', () => {
    const config = calendarAdapterReleaseConfig((name) => input[name as keyof typeof input]);
    expect(cloudRunSecretArgs('calendarAdapter', 'promote', config)).toEqual([
      '--update-secrets',
      'CALENDAR_ADAPTER_KEY=calendar-key:2,DATABASE_URL=calendar-db:3',
    ]);
    expect(cloudRunCalendarArgs('calendarAdapter', 'promote', config)).toContain(
      input.CALENDAR_ADAPTER_SERVICE_ACCOUNT,
    );
    const old = {
      calendarAdapterKeyRef: 'old-key:1',
      calendarAdapterDatabaseRef: 'old-db:1',
      calendarAdapterServiceAccount: 'old@example.iam.gserviceaccount.com',
      calendarAdapterInstance: 'example-project:us-central1:old-instance',
    };
    expect(cloudRunSecretArgs('calendarAdapter', 'rollback', config, old)).toEqual([
      '--update-secrets',
      'CALENDAR_ADAPTER_KEY=old-key:1,DATABASE_URL=old-db:1',
    ]);
    expect(cloudRunCalendarArgs('calendarAdapter', 'rollback', config, old)).toContain(
      old.calendarAdapterInstance,
    );
  });
  it.each([
    'CALENDAR_ADAPTER_KEY_VERSION',
    'CALENDAR_ADAPTER_DATABASE_URL_VERSION',
    'CALENDAR_ADAPTER_INSTANCE_CONNECTION_NAME',
    'CALENDAR_ADAPTER_SERVICE_ACCOUNT',
  ])('refuses missing or floating configuration: %s', (field) => {
    expect(() =>
      calendarAdapterReleaseConfig((name) =>
        name === field ? 'latest' : input[name as keyof typeof input],
      ),
    ).toThrow();
  });
  it('captures references and infrastructure identity without reading secret values', () => {
    const result = parseCloudRunDescription(
      {
        spec: {
          template: {
            metadata: {
              annotations: {
                'run.googleapis.com/cloudsql-instances':
                  input.CALENDAR_ADAPTER_INSTANCE_CONNECTION_NAME,
              },
            },
            spec: {
              serviceAccountName: input.CALENDAR_ADAPTER_SERVICE_ACCOUNT,
              containers: [
                {
                  image: `image@sha256:${'a'.repeat(64)}`,
                  env: [
                    {
                      name: 'CALENDAR_ADAPTER_KEY',
                      valueFrom: { secretKeyRef: { name: 'calendar-key', key: '2' } },
                    },
                    {
                      name: 'DATABASE_URL',
                      valueFrom: { secretKeyRef: { name: 'calendar-db', key: '3' } },
                    },
                  ],
                },
              ],
            },
          },
        },
      },
      ['spec', 'template', 'spec', 'containers'],
    );
    expect(result).toMatchObject({
      calendarAdapterKeyRef: 'calendar-key:2',
      calendarAdapterDatabaseRef: 'calendar-db:3',
      calendarAdapterServiceAccount: input.CALENDAR_ADAPTER_SERVICE_ACCOUNT,
      calendarAdapterInstance: input.CALENDAR_ADAPTER_INSTANCE_CONNECTION_NAME,
    });
  });
});
