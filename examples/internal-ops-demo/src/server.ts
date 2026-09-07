import { prompt, resource, server, tool, z } from '@noodleseed/one';

type RoleContext =
  | 'employee'
  | 'hr_admin'
  | 'support_agent'
  | 'support_engineering'
  | 'finance_viewer'
  | 'finance_approver';

interface EmployeeRecord {
  readonly id: string;
  readonly name: string;
  readonly team: string;
  readonly manager: string;
  readonly location: string;
  readonly employmentStatus: string;
  readonly costCenter: string;
  readonly classification: 'public' | 'restricted';
}

interface CaseRecord {
  readonly id: string;
  readonly account: string;
  readonly severity: 'low' | 'medium' | 'high';
  readonly queue: string;
  readonly status: 'open' | 'waiting' | 'closed';
  readonly title: string;
  readonly customerSummary: string;
  readonly internalNotes: string;
  readonly nextAction: string;
}

interface InvoiceRecord {
  readonly id: string;
  readonly vendor: string;
  readonly amount: number;
  readonly currency: string;
  readonly budgetOwner: string;
  readonly status: 'pending_review' | 'ready_for_approval' | 'approved';
  readonly approvalThreshold: number;
  readonly bankDetails: string;
  readonly risk: 'normal' | 'review_required';
}

const employees: readonly EmployeeRecord[] = [
  {
    id: 'emp-1001',
    name: 'Fatima Khan',
    team: 'Customer Operations',
    manager: 'Maya Chen',
    location: 'Toronto',
    employmentStatus: 'active',
    costCenter: 'OPS-204',
    classification: 'restricted',
  },
  {
    id: 'emp-1002',
    name: 'Jordan Lee',
    team: 'Finance',
    manager: 'Priya Raman',
    location: 'New York',
    employmentStatus: 'active',
    costCenter: 'FIN-110',
    classification: 'restricted',
  },
  {
    id: 'emp-1003',
    name: 'Avery Morgan',
    team: 'Platform Engineering',
    manager: 'Noah Singh',
    location: 'London',
    employmentStatus: 'active',
    costCenter: 'ENG-042',
    classification: 'restricted',
  },
];

const cases: readonly CaseRecord[] = [
  {
    id: 'case-7301',
    account: 'Acme Retail',
    severity: 'high',
    queue: 'support',
    status: 'open',
    title: 'Checkout failures after API credential rotation',
    customerSummary:
      'Acme reports intermittent checkout failures after rotating an upstream commerce API key.',
    internalNotes:
      'Engineering suspects stale connector credentials in the old worker pool. Do not share this diagnosis externally until confirmed.',
    nextAction:
      'Confirm credential propagation, send customer-safe status update, and keep incident open.',
  },
  {
    id: 'case-7302',
    account: 'Northstar Logistics',
    severity: 'medium',
    queue: 'customer-success',
    status: 'waiting',
    title: 'Request for quarterly usage export',
    customerSummary: 'Northstar requested a quarterly usage export for procurement review.',
    internalNotes:
      'Account team is negotiating expansion. Keep export factual; do not mention pricing strategy.',
    nextAction: 'Prepare export packet and route through customer success owner.',
  },
  {
    id: 'case-7303',
    account: 'Acme Retail',
    severity: 'low',
    queue: 'billing',
    status: 'closed',
    title: 'Invoice contact update',
    customerSummary: 'Acme changed its billing contact for the next invoice cycle.',
    internalNotes: 'No risk. Change was verified by account owner.',
    nextAction: 'No action required.',
  },
];

const invoices: readonly InvoiceRecord[] = [
  {
    id: 'inv-9001',
    vendor: 'Northstar Analytics',
    amount: 18400,
    currency: 'USD',
    budgetOwner: 'Jordan Lee',
    status: 'ready_for_approval',
    approvalThreshold: 20000,
    bankDetails: 'US-SECRET-ROUTING-000111 / ACCT-999999',
    risk: 'normal',
  },
  {
    id: 'inv-9002',
    vendor: 'Atlas Data Center',
    amount: 77500,
    currency: 'USD',
    budgetOwner: 'Priya Raman',
    status: 'pending_review',
    approvalThreshold: 20000,
    bankDetails: 'US-SECRET-ROUTING-222333 / ACCT-888888',
    risk: 'review_required',
  },
];

const roleContext = z
  .enum([
    'employee',
    'hr_admin',
    'support_agent',
    'support_engineering',
    'finance_viewer',
    'finance_approver',
  ])
  .default('employee');

function employeeByName(name: string): EmployeeRecord | undefined {
  const normalized = String(name).trim().toLowerCase();
  return employees.find(
    (employee) =>
      employee.name.toLowerCase() === normalized || employee.id.toLowerCase() === normalized,
  );
}

function caseById(id: string): CaseRecord | undefined {
  const normalized = String(id).trim().toLowerCase();
  return cases.find((entry) => entry.id.toLowerCase() === normalized);
}

function invoiceById(id: string): InvoiceRecord | undefined {
  const normalized = String(id).trim().toLowerCase();
  return invoices.find((invoice) => invoice.id.toLowerCase() === normalized);
}

function money(invoice: InvoiceRecord): string {
  return `${invoice.currency} ${invoice.amount.toLocaleString('en-US')}`;
}

function canSeeHrFields(role: RoleContext): boolean {
  return role === 'hr_admin';
}

function canSeeEngineeringNotes(role: RoleContext): boolean {
  return role === 'support_engineering';
}

function canApproveFinance(role: RoleContext): boolean {
  return role === 'finance_approver';
}

function caseSummary(entry: CaseRecord): string {
  return `${entry.id} (${entry.severity}, ${entry.status}, ${entry.queue}): ${entry.title}`;
}

export default server(
  'internal_ops_demo',
  {
    title: 'Internal Operations Demo',
    version: '1.0.0',
    branding: {
      name: 'Internal Operations Demo',
      accent: '#1D9E75',
      radius: 'md',
      density: 'compact',
    },
  },
  [
    tool('lookup_employee', {
      description:
        'Look up a synthetic employee directory record with role-scoped sensitive fields for a governed internal connectivity demo.',
      input: z.object({
        query: z.string().default('Fatima Khan'),
        role_context: roleContext,
      }),
      output: z.object({
        employee_id: z.string(),
        name: z.string(),
        team: z.string(),
        manager: z.string(),
        location: z.string(),
        employment_status: z.string(),
        cost_center: z.string(),
        redactions: z.string(),
        governance_note: z.string(),
      }),
      fulfil: ({ input }) => {
        const record = employeeByName(input.query) ?? employees[0];
        const privileged = canSeeHrFields(input.role_context);
        return {
          employee_id: record.id,
          name: record.name,
          team: record.team,
          manager: record.manager,
          location: record.location,
          employment_status: privileged ? record.employmentStatus : '[REDACTED: hr_admin required]',
          cost_center: privileged ? record.costCenter : '[REDACTED: hr_admin required]',
          redactions: privileged ? 'none' : 'employment_status, cost_center',
          governance_note:
            'Synthetic role_context controls field shaping for the demo. Hosted Noodle policy remains the real authorization boundary.',
        };
      },
    }),
    tool('search_cases', {
      description:
        'Search synthetic support and CRM cases by account, severity, queue, or status without exposing restricted internal notes.',
      input: z.object({
        account: z.string().default('Acme Retail'),
        severity: z.enum(['any', 'low', 'medium', 'high']).default('any'),
        status: z.enum(['any', 'open', 'waiting', 'closed']).default('any'),
      }),
      output: z.object({
        query_summary: z.string(),
        case_summaries: z.string(),
        governance_note: z.string(),
      }),
      fulfil: ({ input }) => {
        const account = String(input.account).trim().toLowerCase();
        const matches = cases.filter(
          (entry) =>
            entry.account.toLowerCase().includes(account) &&
            (input.severity === 'any' || entry.severity === input.severity) &&
            (input.status === 'any' || entry.status === input.status),
        );
        return {
          query_summary: `${matches.length} case(s) matched ${input.account}.`,
          case_summaries: matches.map(caseSummary).join(' | ') || 'No matching cases.',
          governance_note:
            'Search results omit internal notes. Use get_case_detail for role-scoped detail.',
        };
      },
    }),
    tool('get_case_detail', {
      description:
        'Return synthetic support case detail with internal engineering notes redacted unless the caller context is support_engineering.',
      input: z.object({
        case_id: z.string().default('case-7301'),
        role_context: roleContext,
      }),
      output: z.object({
        case_id: z.string(),
        account: z.string(),
        severity: z.string(),
        status: z.string(),
        queue: z.string(),
        title: z.string(),
        customer_summary: z.string(),
        internal_notes: z.string(),
        next_action: z.string(),
        redactions: z.string(),
      }),
      fulfil: ({ input }) => {
        const entry = caseById(input.case_id) ?? cases[0];
        const privileged = canSeeEngineeringNotes(input.role_context);
        return {
          case_id: entry.id,
          account: entry.account,
          severity: entry.severity,
          status: entry.status,
          queue: entry.queue,
          title: entry.title,
          customer_summary: entry.customerSummary,
          internal_notes: privileged
            ? entry.internalNotes
            : '[REDACTED: support_engineering required]',
          next_action: entry.nextAction,
          redactions: privileged ? 'none' : 'internal_notes',
        };
      },
    }),
    tool('draft_customer_reply', {
      description:
        'Draft a customer-safe support response from synthetic case facts. This tool never sends the message.',
      input: z.object({
        case_id: z.string().default('case-7301'),
        tone: z.enum(['concise', 'empathetic', 'executive']).default('empathetic'),
      }),
      output: z.object({
        case_id: z.string(),
        draft: z.string(),
        send_status: z.string(),
        governance_note: z.string(),
      }),
      fulfil: ({ input }) => {
        const entry = caseById(input.case_id) ?? cases[0];
        const prefix =
          input.tone === 'executive'
            ? 'Here is the current status:'
            : input.tone === 'concise'
              ? 'Quick update:'
              : 'Thank you for your patience while we work through this.';
        return {
          case_id: entry.id,
          draft: `${prefix} ${entry.customerSummary} Our next step is to ${entry.nextAction.toLowerCase()}`,
          send_status: 'not_sent',
          governance_note:
            'Draft-only demo action. Sending customer communication would require a separate approved mutation.',
        };
      },
    }),
    tool('lookup_invoice', {
      description:
        'Look up a synthetic vendor invoice. Bank details and payment rails are always redacted from model-visible output.',
      input: z.object({
        invoice_id: z.string().default('inv-9001'),
        role_context: roleContext,
      }),
      output: z.object({
        invoice_id: z.string(),
        vendor: z.string(),
        amount: z.string(),
        budget_owner: z.string(),
        status: z.string(),
        approval_threshold: z.string(),
        risk: z.string(),
        bank_details: z.string(),
        governance_note: z.string(),
      }),
      fulfil: ({ input }) => {
        const invoice = invoiceById(input.invoice_id) ?? invoices[0];
        return {
          invoice_id: invoice.id,
          vendor: invoice.vendor,
          amount: money(invoice),
          budget_owner: invoice.budgetOwner,
          status: invoice.status,
          approval_threshold: `${invoice.currency} ${invoice.approvalThreshold.toLocaleString('en-US')}`,
          risk: invoice.risk,
          bank_details: '[REDACTED: never returned to model-visible MCP output]',
          governance_note: `Role ${input.role_context} may inspect summary fields only. Payment details stay backend-owned.`,
        };
      },
    }),
    tool('check_approval_policy', {
      description:
        'Evaluate synthetic finance approval policy for an invoice and role context without approving payment.',
      input: z.object({
        invoice_id: z.string().default('inv-9001'),
        role_context: roleContext,
      }),
      output: z.object({
        invoice_id: z.string(),
        allowed: z.boolean(),
        reason: z.string(),
        required_next_step: z.string(),
      }),
      fulfil: ({ input }) => {
        const invoice = invoiceById(input.invoice_id) ?? invoices[0];
        const roleAllowed = canApproveFinance(input.role_context);
        const amountAllowed = invoice.amount <= invoice.approvalThreshold;
        const reviewClear = invoice.risk === 'normal' && invoice.status === 'ready_for_approval';
        const allowed = roleAllowed && amountAllowed && reviewClear;
        return {
          invoice_id: invoice.id,
          allowed,
          reason: allowed
            ? 'finance_approver role, amount under threshold, and invoice ready for approval'
            : 'approval requires finance_approver role, ready_for_approval status, normal risk, and amount under threshold',
          required_next_step: allowed
            ? 'Require explicit confirmation before calling approve_invoice.'
            : 'Escalate to finance owner or complete review before approval.',
        };
      },
    }),
    tool('prepare_approval_packet', {
      description:
        'Prepare a synthetic invoice approval packet for human review. This does not approve payment.',
      input: z.object({
        invoice_id: z.string().default('inv-9001'),
      }),
      output: z.object({
        invoice_id: z.string(),
        packet_summary: z.string(),
        approval_status: z.string(),
        sensitive_fields: z.string(),
      }),
      fulfil: ({ input }) => {
        const invoice = invoiceById(input.invoice_id) ?? invoices[0];
        return {
          invoice_id: invoice.id,
          packet_summary: `${invoice.vendor} requests ${money(invoice)}. Budget owner: ${invoice.budgetOwner}. Risk: ${invoice.risk}.`,
          approval_status: 'prepared_not_approved',
          sensitive_fields: 'bank_details_redacted, payment_rails_not_returned',
        };
      },
    }),
    tool('approve_invoice', {
      description:
        'Guarded synthetic invoice approval. It refuses unless finance role, threshold, status, risk, and explicit confirmation all pass.',
      input: z.object({
        invoice_id: z.string().default('inv-9001'),
        role_context: roleContext,
        confirm: z.boolean().default(false),
      }),
      output: z.object({
        invoice_id: z.string(),
        approved: z.boolean(),
        status: z.string(),
        reason: z.string(),
      }),
      fulfil: ({ input }) => {
        const invoice = invoiceById(input.invoice_id) ?? invoices[0];
        const roleAllowed = canApproveFinance(input.role_context);
        const amountAllowed = invoice.amount <= invoice.approvalThreshold;
        const reviewClear = invoice.risk === 'normal' && invoice.status === 'ready_for_approval';
        const approved = input.confirm && roleAllowed && amountAllowed && reviewClear;
        return {
          invoice_id: invoice.id,
          approved,
          status: approved ? 'approved_in_synthetic_demo' : 'refused',
          reason: approved
            ? 'Synthetic approval accepted after role, threshold, risk, status, and confirmation checks.'
            : 'Approval refused. Requires finance_approver role, explicit confirm=true, ready status, normal risk, and amount under threshold.',
        };
      },
    }),
    resource('internal_ops_policy', {
      uri: 'policy://internal-ops-demo',
      title: 'Internal operations demo policy',
      description: 'Synthetic enterprise governance policy for the internal operations demo.',
      mimeType: 'text/markdown',
      // Return the resource body directly; the runtime maps it into MCP `contents`. A `{ contents: [...] }`
      // wrapper would double-wrap (the whole JSON ends up inside contents[0].text).
      fulfil: () =>
        [
          '# Internal Operations Demo Policy',
          '',
          '- Use regular MCP tools only; no MCP Apps widget support is required.',
          '- Treat role_context as synthetic demo input, not an authorization boundary.',
          '- Real authorization is enforced by Noodle access modes, policy admission, and downstream tools.',
          '- Do not expose bank details, raw secrets, bearer tokens, or full internal notes in model-visible output.',
          '- Financial approvals require explicit confirmation and should remain easy to disable by policy.',
        ].join('\n'),
    }),
    resource('employee_directory_record', {
      uri: 'employee://{employee_id}',
      title: 'Employee directory record',
      description: 'Parameterized synthetic employee directory resource with safe summary fields.',
      mimeType: 'text/markdown',
      fulfil: (ctx) => {
        const params = ctx.params ?? {};
        const record = employeeByName(String(params.employee_id ?? 'emp-1001')) ?? employees[0];
        return [
          `# ${record.name}`,
          '',
          `- Team: ${record.team}`,
          `- Manager: ${record.manager}`,
          `- Location: ${record.location}`,
          '- Restricted HR fields are intentionally omitted from resource output.',
        ].join('\n');
      },
    }),
    resource('case_record', {
      uri: 'case://{case_id}',
      title: 'Support case record',
      description: 'Parameterized synthetic support case resource with internal notes redacted.',
      mimeType: 'text/markdown',
      fulfil: (ctx) => {
        const params = ctx.params ?? {};
        const entry = caseById(String(params.case_id ?? 'case-7301')) ?? cases[0];
        return [
          `# ${entry.title}`,
          '',
          `- Account: ${entry.account}`,
          `- Severity: ${entry.severity}`,
          `- Status: ${entry.status}`,
          `- Customer-safe summary: ${entry.customerSummary}`,
          `- Next action: ${entry.nextAction}`,
        ].join('\n');
      },
    }),
    prompt('customer_safe_incident_update', {
      title: 'Customer-safe incident update',
      description: 'Draft a safe external update from a governed internal support case.',
      arguments: z.object({
        case_id: z.string().default('case-7301'),
        audience: z.enum(['customer', 'executive']).default('customer'),
      }),
      fulfil: (ctx) => {
        const params = ctx.params ?? {};
        const entry = caseById(String(params.case_id ?? 'case-7301')) ?? cases[0];
        return {
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: [
                  `Draft a ${params.audience ?? 'customer'}-safe update for ${entry.account}.`,
                  `Case: ${entry.title}`,
                  `Customer summary: ${entry.customerSummary}`,
                  `Next action: ${entry.nextAction}`,
                  'Do not mention internal notes, credentials, or unconfirmed diagnoses.',
                ].join('\n'),
              },
            },
          ],
        };
      },
    }),
    prompt('invoice_approval_brief', {
      title: 'Invoice approval brief',
      description: 'Prepare a human-reviewable invoice approval brief without payment details.',
      arguments: z.object({
        invoice_id: z.string().default('inv-9001'),
      }),
      fulfil: (ctx) => {
        const params = ctx.params ?? {};
        const invoice = invoiceById(String(params.invoice_id ?? 'inv-9001')) ?? invoices[0];
        return {
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: [
                  `Prepare an approval brief for ${invoice.vendor}.`,
                  `Amount: ${money(invoice)}`,
                  `Budget owner: ${invoice.budgetOwner}`,
                  `Risk: ${invoice.risk}`,
                  'Exclude bank details and require explicit human approval before any payment action.',
                ].join('\n'),
              },
            },
          ],
        };
      },
    }),
  ],
);
