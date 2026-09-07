import { annotations, connector, resource, server, tool, z } from '@noodleseed/one';

const state = connector('noodle_state')
  .version('1.0.0')
  .operation('read_state', {
    type: 'read',
    input: z.object({
      handle: z.string(),
      key: z.string().optional(),
    }),
    output: z.object({
      value: z.record(z.string(), z.unknown()),
      revision: z.number().int(),
      status: z.string(),
    }),
  })
  .operation('patch_state', {
    type: 'action',
    input: z.object({
      handle: z.string(),
      expectedRevision: z.number().int(),
      value: z.record(z.string(), z.unknown()),
    }),
    output: z.object({
      value: z.record(z.string(), z.unknown()),
      revision: z.number().int(),
      status: z.string(),
    }),
  });

const syntheticNotice =
  'Synthetic credit-union demo data only; no core banking, credit bureau, or loan-origination systems are connected.';

const members = [
  {
    id: 'm-1042',
    name: 'Jordan Lee',
    membershipTier: 'Premier Checking',
    relationshipYears: 7,
    checkingBalance: 8420,
    monthlyDeposit: 6200,
    creditScoreBand: '740-759',
    consentStatus: 'member-permissioned aggregation',
  },
  {
    id: 'm-2119',
    name: 'Priya Shah',
    membershipTier: 'Everyday Checking',
    relationshipYears: 3,
    checkingBalance: 3120,
    monthlyDeposit: 4800,
    creditScoreBand: '700-719',
    consentStatus: 'member-permissioned aggregation',
  },
] as const;

const recurringPayments = [
  {
    id: 'txn-auto-1',
    memberId: 'm-1042',
    payee: 'Metro Auto Finance',
    category: 'Auto loan',
    amount: 612,
    cadence: 'monthly',
    firstSeen: '2025-02-15',
    confidence: 0.94,
  },
  {
    id: 'txn-insurance-1',
    memberId: 'm-1042',
    payee: 'Shield Mutual',
    category: 'Auto insurance',
    amount: 128,
    cadence: 'monthly',
    firstSeen: '2024-09-04',
    confidence: 0.86,
  },
  {
    id: 'txn-auto-2',
    memberId: 'm-2119',
    payee: 'Citywide Auto Credit',
    category: 'Auto loan',
    amount: 455,
    cadence: 'monthly',
    firstSeen: '2025-08-01',
    confidence: 0.9,
  },
] as const;

const refinanceOffers = [
  {
    id: 'refi-1042',
    memberId: 'm-1042',
    detectedLender: 'Metro Auto Finance',
    currentPayment: 612,
    estimatedCurrentApr: 8.4,
    creditUnionApr: 5.9,
    estimatedNewPayment: 552,
    estimatedMonthlySavings: 60,
    estimatedAnnualSavings: 720,
    termMonths: 48,
    vehicle: '2022 Honda CR-V',
    confidence: 0.88,
    nextBestAction: 'Invite Jordan to a prefilled auto refinance review.',
  },
  {
    id: 'refi-2119',
    memberId: 'm-2119',
    detectedLender: 'Citywide Auto Credit',
    currentPayment: 455,
    estimatedCurrentApr: 9.1,
    creditUnionApr: 6.8,
    estimatedNewPayment: 421,
    estimatedMonthlySavings: 34,
    estimatedAnnualSavings: 408,
    termMonths: 54,
    vehicle: '2021 Toyota Corolla',
    confidence: 0.79,
    nextBestAction: 'Ask Priya whether she wants a soft-pull refinance estimate.',
  },
] as const;

const outreachPlays = [
  {
    id: 'secure-message',
    title: 'Secure message',
    channel: 'Online banking',
    complianceNote:
      'Use estimated savings language and disclose that final terms require application.',
  },
  {
    id: 'branch-task',
    title: 'Branch follow-up',
    channel: 'Member service queue',
    complianceNote: 'Route to a loan officer before discussing underwriting decisions.',
  },
  {
    id: 'mobile-card',
    title: 'Mobile app insight card',
    channel: 'Mobile banking',
    complianceNote: 'Let the member dismiss or request details; do not auto-apply.',
  },
] as const;

const memberShape = z.object({
  id: z.string(),
  name: z.string(),
  membershipTier: z.string(),
  relationshipYears: z.number(),
  checkingBalance: z.number(),
  monthlyDeposit: z.number(),
  creditScoreBand: z.string(),
  consentStatus: z.string(),
});

const paymentShape = z.object({
  id: z.string(),
  memberId: z.string(),
  payee: z.string(),
  category: z.string(),
  amount: z.number(),
  cadence: z.string(),
  firstSeen: z.string(),
  confidence: z.number(),
});

const offerShape = z.object({
  id: z.string(),
  memberId: z.string(),
  detectedLender: z.string(),
  currentPayment: z.number(),
  estimatedCurrentApr: z.number(),
  creditUnionApr: z.number(),
  estimatedNewPayment: z.number(),
  estimatedMonthlySavings: z.number(),
  estimatedAnnualSavings: z.number(),
  termMonths: z.number(),
  vehicle: z.string(),
  confidence: z.number(),
  nextBestAction: z.string(),
});

const playShape = z.object({
  id: z.string(),
  title: z.string(),
  channel: z.string(),
  complianceNote: z.string(),
});

const workspaceInput = z.object({
  activeMemberId: z.string().default('m-1042'),
  activeTab: z.enum(['member', 'loan', 'offer', 'outreach']).default('offer'),
  selectedPlayIds: z.array(z.string()).default([]),
  expectedRevision: z.number().int().min(0).default(0),
});

const workspaceStateSchema = z.object({
  activeMemberId: z.string(),
  activeTab: z.enum(['member', 'loan', 'offer', 'outreach']),
  selectedPlayIds: z.array(z.string()),
  status: z.string(),
});

const readOnly = annotations.readOnly();
const action = annotations.openAction({ destructive: false, confirm: false });

export default server(
  'credit_union',
  {
    title: 'Credit Union Refinance Finder',
    version: '1.0.0',
    use: { state },
    state: {
      handles: {
        refi_workspace: {
          kind: 'workflow',
          version: 'v1',
          scope: 'caller',
          ttlSeconds: 7200,
          schema: workspaceStateSchema,
        },
      },
    },
    branding: {
      name: 'Credit Union',
      accent: '#146C5A',
      surface: '#F5FAF8',
      surfaceDark: '#071514',
      radius: 'md',
      density: 'compact',
      typography: 'system',
      colorScheme: 'auto',
    },
    handoff: {
      allowedDomains: ['https://creditunion.example.com'],
    },
  },
  [
    tool('open_refinance_finder', {
      description:
        'Open a credit-union member dashboard that detects recurring external auto-loan payments from checking activity and estimates a refinance opportunity.',
      annotations: readOnly,
      input: z.object({
        memberId: z.string().optional(),
      }),
      output: z.object({
        status: z.string(),
        syntheticNotice: z.string(),
        members: z.array(memberShape),
        recurringPayments: z.array(paymentShape),
        refinanceOffers: z.array(offerShape),
        outreachPlays: z.array(playShape),
        fallback: z.string(),
      }),
      fulfil: () => ({
        status: 'Auto refinance opportunity dashboard ready.',
        syntheticNotice,
        members,
        recurringPayments,
        refinanceOffers,
        outreachPlays,
        fallback:
          'Detected recurring external auto-loan payments for two members. Jordan Lee appears eligible for an estimated $60/month credit-union refinance savings opportunity.',
      }),
      viewTitle: 'Auto refinance finder',
      domain: 'https://creditunion.example.com',
      view: {
        component: 'refinance-dashboard',
        entry: './views/refinance-dashboard.tsx',
      },
      viewDescription:
        'A banker-facing dashboard for identifying refinance opportunities from member checking-account patterns.',
      csp: {
        connectDomains: ['https://creditunion.example.com'],
        resourceDomains: ['https://creditunion.example.com'],
        frameDomains: ['https://creditunion.example.com'],
      },
    }),
    tool('list_members', {
      visibility: ['app'],
      description: 'List synthetic credit-union members for the refinance finder.',
      annotations: readOnly,
      input: z.object({}),
      output: z.object({ members: z.array(memberShape), syntheticNotice: z.string() }),
      fulfil: () => ({ members, syntheticNotice }),
    }),
    tool('detect_recurring_auto_loans', {
      visibility: ['app'],
      description: 'Return recurring checking-account payments that look like external auto loans.',
      annotations: readOnly,
      input: z.object({
        memberId: z.string().optional(),
      }),
      output: z.object({ payments: z.array(paymentShape), syntheticNotice: z.string() }),
      fulfil: () => ({ payments: recurringPayments, syntheticNotice }),
    }),
    tool('estimate_refinance_offer', {
      visibility: ['app'],
      description: 'Estimate a synthetic credit-union auto refinance offer for a member.',
      annotations: readOnly,
      input: z.object({
        memberId: z.string().optional(),
      }),
      output: z.object({
        offers: z.array(offerShape),
        outreachPlays: z.array(playShape),
        syntheticNotice: z.string(),
      }),
      fulfil: () => ({ offers: refinanceOffers, outreachPlays, syntheticNotice }),
    }),
    tool('sync_refi_workspace', {
      visibility: ['app'],
      description: 'Patch the caller-scoped refinance dashboard workspace state.',
      annotations: action,
      input: workspaceInput,
      output: z.object({
        workspace: workspaceStateSchema,
        revision: z.number(),
        status: z.string(),
      }),
      fulfil: ({ input, connectors }) => {
        const workspace = {
          activeMemberId: input.activeMemberId,
          activeTab: input.activeTab,
          selectedPlayIds: input.selectedPlayIds,
          status: 'saved',
        };
        const state = connectors.state.patchState({
          handle: 'refi_workspace',
          expectedRevision: input.expectedRevision,
          value: workspace,
        });
        return { workspace, revision: state.revision, status: state.status };
      },
    }),
    tool('summarize_refinance_opportunities', {
      description:
        'Summarize synthetic member checking and auto-loan refinance opportunities without opening the widget.',
      annotations: readOnly,
      input: z.object({}),
      output: z.object({
        members: z.array(memberShape),
        recurringPayments: z.array(paymentShape),
        refinanceOffers: z.array(offerShape),
        syntheticNotice: z.string(),
      }),
      fulfil: () => ({ members, recurringPayments, refinanceOffers, syntheticNotice }),
    }),
    resource('credit_union_refi_playbook', {
      uri: 'docs://credit-union-refi-playbook',
      title: 'Auto refinance opportunity playbook',
      description: 'Synthetic playbook for acting on member auto refinance opportunities.',
      mimeType: 'text/markdown',
      // Return the resource body itself. The runtime maps it into `contents`; returning the
      // `{ contents: [...] }` wrapper double-wraps it and fails to compile.
      fulfil: () =>
        [
          '# Auto Refinance Opportunity Playbook',
          '',
          '- Use member-permissioned transaction patterns to detect recurring external auto-loan payments.',
          '- Present estimated savings as an invitation to review, not as an approval or final offer.',
          '- Keep underwriting, credit pulls, and final loan documents in the credit union loan-origination system.',
        ].join('\n'),
    }),
  ],
);
