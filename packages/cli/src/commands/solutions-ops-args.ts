import { parseCommandFlags } from './shared.js';

const VALUES = {
  '--service': 'service',
  '--auth-token': 'authToken',
  '--org': 'org',
  '--app': 'app',
  '--env': 'env',
  '--retention-days': 'retentionDays',
  '--display-name': 'displayName',
  '--privacy-url': 'privacyUrl',
  '--support-url': 'supportUrl',
  '--role': 'role',
  '--subject': 'subject',
  '--email': 'email',
  '--expected-revision': 'expectedRevision',
  '--status': 'status',
  '--filters': 'filters',
  '--sort-field': 'sortField',
  '--sort-direction': 'sortDirection',
  '--created-at-from': 'createdAtFrom',
  '--created-at-to': 'createdAtTo',
  '--assignee': 'assignee',
  '--data': 'data',
  '--unset': 'unset',
  '--note': 'note',
  '--idempotency-key': 'idempotencyKey',
  '--cursor': 'cursor',
  '--limit': 'limit',
  '--publisher-org': 'publisherOrg',
  '--definition-app': 'definitionApp',
  '--definition-env': 'definitionEnv',
  '--deployment': 'deploymentId',
  '--binding-reference': 'bindingReference',
  '--binding-generation': 'bindingGeneration',
  '--configuration-reference': 'configurationReference',
} as const;

const BOOLEANS = {
  '--json': 'json',
  '--include-deleted': 'includeDeleted',
  '--enable': 'enable',
  '--replace': 'replace',
} as const;

function parseArgs(rest: readonly string[]) {
  return parseCommandFlags(rest, { values: VALUES, booleans: BOOLEANS });
}

export { parseArgs };
