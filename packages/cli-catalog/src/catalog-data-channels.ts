/** Assisted messaging setup and operations; the service remains authoritative. */
import type { CommandSpec, FlagSpec, SubcommandSpec } from './catalog-types.js';

const flag = (
  name: string,
  summary: string,
  type: 'string' | 'number' | 'boolean' = 'string',
): FlagSpec => ({
  name,
  summary,
  type,
  ...(type === 'boolean' ? {} : { value: '<value>' }),
  required: false,
  repeatable: false,
  sensitive: name === 'auth-token',
  aliases: [],
  conflictsWith: [],
});
const scope = [
  flag('org', 'Organization.'),
  flag('app', 'Application.'),
  flag('env', 'Environment.'),
  flag('service', 'Service URL.'),
  flag('auth-token', 'Control-plane token.'),
  flag('json', 'Machine-readable output.', 'boolean'),
];
const mutation = [flag('idempotency-key', 'Stable key for retrying this logical change.')];
const revision = flag(
  'expected-revision',
  'Current revision from status; zero when creating.',
  'number',
);
const blockScope = flag('scope', 'local (default) or explicit provider block.');
const participant = flag('participant-id', 'Protected participant identifier from events list.');
const limits = [
  'per-minute',
  'per-hour',
  'per-day',
  'channel-per-day',
  'new-participants-per-day',
  'concurrent',
  'pending-per-participant',
  'pending',
  'text-characters',
  'daily-micro-usd',
].map((name) => flag(name, `Lower the ${name} ceiling; zero disables this allowance.`, 'number'));
const leaf = (name: string, summary: string, flags: readonly FlagSpec[] = []): SubcommandSpec => ({
  name,
  summary,
  flags: [...scope, ...flags],
  arguments: [],
  jsonOutput: { mode: 'single' },
});
const group = (
  name: string,
  summary: string,
  subcommands: readonly SubcommandSpec[],
): SubcommandSpec => ({ name, summary, subcommands, flags: [], arguments: [] });
export const CHANNELS_COMMAND: CommandSpec = {
  name: 'channels',
  section: 'operate',
  summary: 'Connect and operate the same application on messaging channels.',
  arguments: [],
  flags: [],
  subcommands: [
    group(
      'whatsapp',
      'Configure a 360dialog or Meta Cloud API number, test readiness, and control public messaging.',
      [
        leaf('status', 'Show configuration and current revision.'),
        leaf('configure', 'Save a paused binding using managed secret references.', [
          revision,
          ...mutation,
          flag('provider', '360dialog (default) or meta for the Meta Cloud API.'),
          flag('phone-number-id', '360dialog/Meta phone-number asset ID.'),
          flag('waba-id', 'WhatsApp Business Account ID; required with --provider meta.'),
          flag(
            'api-key-secret',
            'Managed secret name for the 360dialog key or the Meta business token.',
          ),
          flag('webhook-secret', 'Independent managed callback secret name; 360dialog only.'),
          flag('capabilities', 'Comma-separated knowledge:name or tool:name selections.'),
          flag('support-email', 'Contact shown when an answer cannot be completed.'),
          ...limits,
        ]),
        leaf(
          'doctor',
          'Check deployment, storage, worker, model cost bound, provider setup, and capability compatibility.',
          mutation,
        ),
        leaf('enable', 'Enable after a successful current readiness check.', [
          revision,
          ...mutation,
        ]),
        leaf('pause', 'Stop new work and unsent replies.', [revision, ...mutation]),
        leaf('disconnect', 'Fence this binding and retain governed receipts.', [
          revision,
          ...mutation,
        ]),
        group('webhook', 'Inspect or configure the owned provider callback.', [
          leaf('inspect', 'Check URL and authentication without disclosing headers.'),
          leaf('configure', 'Register the service-owned callback.', [revision, ...mutation]),
        ]),
        group('limits', 'Inspect or lower the approved limits.', [
          leaf('get', 'Show limits.'),
          leaf('set', 'Lower selected limits.', [revision, ...mutation, ...limits]),
        ]),
        leaf('usage', 'Show UTC-day settled and reserved inference spend.'),
        group('blocks', 'Inspect local blocks.', [
          leaf('list', 'List local and provider block evidence.', [
            flag('after', 'Cursor from the previous page.'),
          ]),
        ]),
        leaf('block', 'Block locally; optionally request a provider block.', [
          participant,
          blockScope,
          flag('phone-stdin', 'Read a phone number securely from standard input.', 'boolean'),
          flag('until', 'Expiry as an ISO timestamp.'),
          flag('indefinite', 'Explicitly retain this block until removed.', 'boolean'),
          ...mutation,
        ]),
        leaf('unblock', 'Remove an explicitly selected block without resetting usage.', [
          participant,
          blockScope,
          flag(
            'phone-stdin',
            'Supply the number if retained participant context has expired.',
            'boolean',
          ),
          ...mutation,
        ]),
        group('cooldown', 'Inspect or clear an automatic cooldown.', [
          leaf('inspect', 'Show a participant cooldown.', [participant]),
          leaf('clear', 'Clear cooldown without resetting quotas.', [participant, ...mutation]),
        ]),
        group('events', 'Inspect content-free transport receipts.', [
          leaf('list', 'List a page of events.', [
            flag('after', 'Cursor returned by the previous page.'),
          ]),
          leaf('inspect', 'Inspect one event.', [flag('event-id', 'Event identifier.')]),
          leaf('reconcile', 'Read current receipt evidence without resending.', [
            flag('event-id', 'Event identifier.'),
            ...mutation,
          ]),
        ]),
        group('conversation', 'Erase conversation content.', [
          leaf(
            'forget',
            'Erase participant context and message content while preserving safeguards.',
            [participant, ...mutation],
          ),
        ]),
      ],
    ),
  ],
};
