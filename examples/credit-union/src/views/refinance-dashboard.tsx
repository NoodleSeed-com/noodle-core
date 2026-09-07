import '@noodleseed/one/react/styles.css';
import {
  Action,
  Collection,
  Fact,
  Flow,
  Frame,
  Region,
  ShellNav,
  StatusBadge,
  useAppFlow,
  useCallTool,
  useOpenExternal,
  useSendFollowUpMessage,
  useToolInfo,
  useViewState,
  View,
  ViewStack,
} from '../helpers.js';
import './widget-style.css';

type ViewName = 'member' | 'loan' | 'offer' | 'outreach';
type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

type Member = {
  readonly id: string;
  readonly name: string;
  readonly membershipTier: string;
  readonly relationshipYears: number;
  readonly checkingBalance: number;
  readonly monthlyDeposit: number;
  readonly creditScoreBand: string;
  readonly consentStatus: string;
};

type Payment = {
  readonly id: string;
  readonly memberId: string;
  readonly payee: string;
  readonly category: string;
  readonly amount: number;
  readonly cadence: string;
  readonly firstSeen: string;
  readonly confidence: number;
};

type Offer = {
  readonly id: string;
  readonly memberId: string;
  readonly detectedLender: string;
  readonly currentPayment: number;
  readonly estimatedCurrentApr: number;
  readonly creditUnionApr: number;
  readonly estimatedNewPayment: number;
  readonly estimatedMonthlySavings: number;
  readonly estimatedAnnualSavings: number;
  readonly termMonths: number;
  readonly vehicle: string;
  readonly confidence: number;
  readonly nextBestAction: string;
};

type OutreachPlay = {
  readonly id: string;
  readonly title: string;
  readonly channel: string;
  readonly complianceNote: string;
};

type DashboardPayload = {
  readonly status?: string;
  readonly syntheticNotice?: string;
  readonly members?: readonly Member[];
  readonly recurringPayments?: readonly Payment[];
  readonly refinanceOffers?: readonly Offer[];
  readonly outreachPlays?: readonly OutreachPlay[];
};

function structured<T>(value: unknown): T | undefined {
  return (value as { readonly structuredContent?: T } | undefined)?.structuredContent;
}

function money(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function apr(value: number): string {
  return `${value.toFixed(1)}%`;
}

function toneForConfidence(value: number): Tone {
  if (value >= 0.85) return 'success';
  if (value >= 0.75) return 'warning';
  return 'neutral';
}

export default function RefinanceDashboard() {
  const entry = structured<DashboardPayload>(useToolInfo('open_refinance_finder'));
  const flow = useAppFlow<ViewName>({
    key: 'credit_union_refi_flow',
    initialView: 'offer',
    views: ['member', 'loan', 'offer', 'outreach'],
  });
  const view = flow.activeView;
  const setView = flow.navigate;
  const openExternal = useOpenExternal();
  const sendFollowUpMessage = useSendFollowUpMessage();
  const listMembers = useCallTool('list_members');
  const detectLoans = useCallTool('detect_recurring_auto_loans');
  const estimateOffer = useCallTool('estimate_refinance_offer');
  const syncWorkspace = useCallTool('sync_refi_workspace');

  const memberData = structured<{ readonly members?: readonly Member[] }>(listMembers.data);
  const loanData = structured<{ readonly payments?: readonly Payment[] }>(detectLoans.data);
  const offerData = structured<{
    readonly offers?: readonly Offer[];
    readonly outreachPlays?: readonly OutreachPlay[];
  }>(estimateOffer.data);

  const members = memberData?.members ?? entry?.members ?? [];
  const [activeMemberId, setActiveMemberId] = useViewState(
    'active_member',
    entry?.members?.[0]?.id ?? 'm-1042',
  );
  const [selectedPlayIds, setSelectedPlayIds] = useViewState<readonly string[]>(
    'selected_refi_plays',
    [],
  );
  const [revision, setRevision] = useViewState('refi_workspace_revision', 0);
  const activeMember = members.find((member) => member.id === activeMemberId) ?? members[0];
  const payments = (loanData?.payments ?? entry?.recurringPayments ?? []).filter(
    (payment) => !activeMember || payment.memberId === activeMember.id,
  );
  const autoLoanPayments = payments.filter((payment) => payment.category === 'Auto loan');
  const offers = (offerData?.offers ?? entry?.refinanceOffers ?? []).filter(
    (offer) => !activeMember || offer.memberId === activeMember.id,
  );
  const offer = offers[0];
  const outreachPlays = offerData?.outreachPlays ?? entry?.outreachPlays ?? [];
  const notice =
    entry?.syntheticNotice ??
    'Synthetic credit-union demo data; no live banking systems connected.';

  async function chooseMember(member: Member) {
    setActiveMemberId(member.id);
    await Promise.all([
      detectLoans.callTool({ memberId: member.id }),
      estimateOffer.callTool({ memberId: member.id }),
    ]);
  }

  async function saveWorkspace() {
    const result = await syncWorkspace.callTool({
      activeMemberId: activeMember?.id ?? activeMemberId,
      activeTab: view,
      selectedPlayIds,
      expectedRevision: revision,
    });
    const synced = structured<{ readonly revision?: number }>(result);
    setRevision(synced?.revision ?? revision + 1);
  }

  function togglePlay(playId: string) {
    setSelectedPlayIds(
      selectedPlayIds.includes(playId)
        ? selectedPlayIds.filter((id) => id !== playId)
        : [...selectedPlayIds, playId],
    );
  }

  return (
    <Frame
      className="credit-union-frame"
      data-llm={`Credit union refinance finder. Active member ${
        activeMember?.name ?? 'none'
      }, tab ${view}, selected outreach plays ${selectedPlayIds.length}.`}
      title="CREDIT UNION"
      subtitle={entry?.status ?? 'Checking patterns, recurring loans, and refinance fit.'}
      icon={<CreditUnionMark />}
      status={<StatusBadge tone="info">Member insight</StatusBadge>}
      actions={
        <Action variant="primary" pending={syncWorkspace.isPending} onClick={saveWorkspace}>
          Save review
        </Action>
      }
      footer={`${selectedPlayIds.length} outreach plays selected · revision ${revision}`}
    >
      <ShellNav
        activeView={view}
        aria-label="Auto refinance dashboard"
        items={[
          { view: 'member', label: 'Member' },
          { view: 'loan', label: 'Loan Signals' },
          { view: 'offer', label: 'Refi Fit' },
          { view: 'outreach', label: 'Outreach' },
        ]}
        onNavigate={setView}
      />

      <Flow variant="sidebar">
        <Region title="Members" description="Synthetic checking-account relationships">
          <Collection variant="list" selectionMode="single">
            {members.map((member) => (
              <Collection.Item
                as="button"
                key={member.id}
                selected={member.id === activeMember?.id}
                title={member.name}
                description={`${member.membershipTier} · ${member.relationshipYears} years`}
                meta={member.creditScoreBand}
                type="button"
                onClick={() => chooseMember(member)}
              />
            ))}
          </Collection>
          <Action pending={listMembers.isPending} onClick={() => listMembers.callTool({})}>
            Refresh members
          </Action>
        </Region>

        <Flow variant="stack">
          <Region
            title={activeMember?.name ?? 'Select a member'}
            description={
              offer?.nextBestAction ?? 'Load a member to inspect recurring loan signals.'
            }
            status={
              offer ? (
                <StatusBadge tone={toneForConfidence(offer.confidence)}>
                  {percent(offer.confidence)} confidence
                </StatusBadge>
              ) : null
            }
          >
            <ViewStack flow={flow}>
              <View name="member">
                <Flow variant="grid">
                  <Fact
                    label="Checking balance"
                    value={activeMember ? money(activeMember.checkingBalance) : '-'}
                  />
                  <Fact
                    label="Monthly deposits"
                    value={activeMember ? money(activeMember.monthlyDeposit) : '-'}
                  />
                  <Fact label="Credit band" value={activeMember?.creditScoreBand ?? '-'} />
                  <Fact label="Consent" value={activeMember?.consentStatus ?? '-'} />
                </Flow>
              </View>

              <View name="loan">
                <Collection variant="list">
                  {payments.map((payment) => (
                    <Collection.Item
                      key={payment.id}
                      title={payment.payee}
                      description={`${payment.category} · ${payment.cadence} · first seen ${payment.firstSeen}`}
                      meta={
                        <StatusBadge tone={toneForConfidence(payment.confidence)}>
                          {money(payment.amount)}
                        </StatusBadge>
                      }
                    />
                  ))}
                </Collection>
              </View>

              <View name="offer">
                {offer ? (
                  <Flow variant="grid">
                    <Fact label="Current lender" value={offer.detectedLender} />
                    <Fact label="Vehicle" value={offer.vehicle} />
                    <Fact label="Current APR est." value={apr(offer.estimatedCurrentApr)} />
                    <Fact
                      label="CU APR estimate"
                      value={apr(offer.creditUnionApr)}
                      tone="success"
                    />
                    <Fact label="Current payment" value={money(offer.currentPayment)} />
                    <Fact label="New payment est." value={money(offer.estimatedNewPayment)} />
                    <Fact
                      label="Monthly savings"
                      value={money(offer.estimatedMonthlySavings)}
                      tone="success"
                    />
                    <Fact
                      label="Annual savings"
                      value={money(offer.estimatedAnnualSavings)}
                      tone="success"
                    />
                  </Flow>
                ) : null}
              </View>

              <View name="outreach">
                <OutreachCollection
                  plays={outreachPlays}
                  selectedPlayIds={selectedPlayIds}
                  onToggle={togglePlay}
                />
              </View>
            </ViewStack>
          </Region>

          <Flow variant="split">
            <Region title="Detected auto loan">
              <Collection variant="list">
                {autoLoanPayments.map((payment) => (
                  <Collection.Item
                    key={payment.id}
                    title={payment.payee}
                    description={`Recurring ${payment.cadence} payment from checking account`}
                    meta={`${percent(payment.confidence)} match`}
                  />
                ))}
              </Collection>
            </Region>
            <Region title="Member value">
              <Flow variant="grid" density="compact">
                <Fact
                  label="Payment reduction"
                  value={offer ? money(offer.currentPayment - offer.estimatedNewPayment) : '-'}
                  tone="success"
                />
                <Fact label="Remaining term" value={offer ? `${offer.termMonths} months` : '-'} />
                <Fact label="Selected plays" value={String(selectedPlayIds.length)} />
              </Flow>
            </Region>
          </Flow>

          <Flow variant="cluster" density="compact">
            <Action
              variant="primary"
              onClick={() => openExternal('https://creditunion.example.com/refinance')}
            >
              Open LOS review
            </Action>
            <Action
              variant="secondary"
              pending={estimateOffer.isPending}
              onClick={() => estimateOffer.callTool({ memberId: activeMember?.id })}
            >
              Recalculate fit
            </Action>
            <Action
              variant="quiet"
              onClick={() =>
                sendFollowUpMessage({
                  prompt: `Draft a compliant auto refinance outreach note for ${
                    activeMember?.name ?? 'the selected member'
                  } using only estimated savings language.`,
                })
              }
            >
              Draft outreach
            </Action>
          </Flow>
          <p className="credit-union-notice">{notice}</p>
        </Flow>
      </Flow>
    </Frame>
  );
}

function OutreachCollection({
  plays,
  selectedPlayIds,
  onToggle,
}: {
  readonly plays: readonly OutreachPlay[];
  readonly selectedPlayIds: readonly string[];
  readonly onToggle: (id: string) => void;
}) {
  return (
    <Collection variant="list" selectionMode="multiple">
      {plays.map((play) => (
        <Collection.Item
          as="button"
          key={play.id}
          selected={selectedPlayIds.includes(play.id)}
          title={play.title}
          description={`${play.channel}: ${play.complianceNote}`}
          meta={
            <StatusBadge tone={selectedPlayIds.includes(play.id) ? 'success' : 'neutral'}>
              play
            </StatusBadge>
          }
          type="button"
          onClick={() => onToggle(play.id)}
        />
      ))}
    </Collection>
  );
}

function CreditUnionMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 10h16" />
      <path d="M6 10v8" />
      <path d="M10 10v8" />
      <path d="M14 10v8" />
      <path d="M18 10v8" />
      <path d="M3 18h18" />
      <path d="M12 4 4 10h16L12 4Z" />
    </svg>
  );
}
