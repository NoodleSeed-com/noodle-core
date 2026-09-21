import type { ChannelBinding } from '@noodle-borg/assistant-gateway/portable';
import type { ArtifactFulfilment, RuntimeArtifact } from '@noodle-borg/compiler';
import type {
  BusinessInformationStore,
  SolutionInstallation,
} from '../business-information/contracts.js';

/**
 * The per-capability compatibility report inside channel readiness (ADR 0240 decision 7). Each
 * entry is derived from what the binding's selected tools imply, never from a hand-authored
 * matrix: knowledge answers questions, pure reads look up information, a `collect` opener with its
 * admitted native-record action captures a request, and account self-service stays unavailable
 * until the profile can establish verified customer identity. Readiness itself is unchanged.
 */
export type CapabilityStatus = 'native' | 'adapted' | 'handoff' | 'needs_setup' | 'unavailable';
export interface CapabilityReport {
  readonly capability: string;
  readonly status: CapabilityStatus;
  readonly code?: string;
  readonly requirement?: string;
  readonly next?: string;
}
export type CapabilityInstallations = Pick<BusinessInformationStore, 'listInstallations'>;
export interface CapabilityReportInput {
  /** The projected artifact, absent when the deployment check could not produce one. */
  readonly artifact: RuntimeArtifact | undefined;
  readonly tenant: ChannelBinding['tenant'];
  readonly durable: boolean;
  readonly installations: CapabilityInstallations | undefined;
}

const ACCOUNT_SELF_SERVICE: CapabilityReport = {
  capability: 'account_self_service',
  status: 'unavailable',
  code: 'IDENTITY_NOT_ESTABLISHABLE',
  requirement: 'verified_customer',
  next: 'Account questions are answered as limitations until WhatsApp identity linking ships.',
};

export async function capabilityReport(
  input: CapabilityReportInput,
): Promise<readonly CapabilityReport[]> {
  const { artifact } = input;
  if (artifact === undefined) return [ACCOUNT_SELF_SERVICE];
  const reports: CapabilityReport[] = [];
  const interactions = artifact.toolInteractions ?? {};
  const present = new Set(artifact.tools.map((tool) => tool.name));
  const openers = Object.entries(interactions).filter(
    ([opener, interaction]) => present.has(opener) && present.has(interaction.action),
  );
  const actions = new Set(openers.map(([, interaction]) => interaction.action));
  if ((artifact.server.knowledge?.length ?? 0) > 0)
    reports.push({ capability: 'answer_questions', status: 'native' });
  const reads = artifact.tools.filter(
    (tool) =>
      tool.annotations?.readOnlyHint === true &&
      interactions[tool.name] === undefined &&
      !actions.has(tool.name),
  );
  if (reads.length > 0) reports.push({ capability: 'look_up_information', status: 'native' });
  if (openers.length > 0) {
    const setup = await captureSetup(input, artifact, openers);
    reports.push({ capability: 'capture_request', ...(setup ?? { status: 'native' }) });
  }
  reports.push(ACCOUNT_SELF_SERVICE);
  return reports;
}

/** The first missing prerequisite of any selected collect action, mirroring the record connector's own gates. */
async function captureSetup(
  input: CapabilityReportInput,
  artifact: RuntimeArtifact,
  openers: ReadonlyArray<[string, { readonly action: string }]>,
): Promise<Omit<CapabilityReport, 'capability'> | undefined> {
  const needs = (code: string, requirement: string, next: string) => ({
    status: 'needs_setup' as const,
    code,
    requirement,
    next,
  });
  if (!input.durable)
    return needs(
      'durable_storage_required',
      'durable_interaction_store',
      'Run the service with PostgreSQL channel storage, then rerun doctor.',
    );
  if (input.installations === undefined)
    return needs(
      'business_information_unavailable',
      'collection_installation',
      'Enable managed business information on this service, then rerun doctor.',
    );
  const installations = (await input.installations.listInstallations(input.tenant.org)).filter(
    (item) => item.scope.app === input.tenant.app && item.scope.env === input.tenant.env,
  );
  const installation = installations.length === 1 ? installations[0] : undefined;
  if (installation === undefined)
    return needs(
      'collection_not_installed',
      'collection_installation',
      "Install the application's collections for this environment, then rerun doctor.",
    );
  for (const [, interaction] of openers) {
    const action = artifact.tools.find((tool) => tool.name === interaction.action);
    const collection = action === undefined ? undefined : targetCollection(action.fulfilment);
    if (collection !== undefined && !enabled(installation, collection))
      return needs(
        'collection_not_installed',
        'collection_installation',
        `Enable the "${collection}" collection on the installation, then rerun doctor.`,
      );
  }
  if (!installation.intakeActive)
    return needs(
      'intake_inactive',
      'public_intake',
      'Resume public intake for the installation, then rerun doctor.',
    );
  return undefined;
}

function enabled(installation: SolutionInstallation, collection: string): boolean {
  return (
    installation.managedCollections.includes(collection) &&
    installation.definition.collections.some((entry) => entry.key === collection)
  );
}

/** The literal `collection` argument of the action's single native-record operation, when readable. */
function targetCollection(fulfilment: ArtifactFulfilment): string | undefined {
  const args =
    fulfilment.kind === 'operation'
      ? [fulfilment.args]
      : fulfilment.steps.flatMap((step) => (step.kind === 'operation' ? [step.args] : []));
  for (const map of args) {
    const node = map.collection;
    if (node?.kind === 'literal' && typeof node.value === 'string') return node.value;
  }
  return undefined;
}
