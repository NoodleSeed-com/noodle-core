# Internal Operations Demo

**Owns:** The enterprise governed internal-connectivity flagship example.
**Read when:** Demonstrating regular MCP access to synthetic internal systems with policy, audit, redaction,
and safe high-risk action boundaries.
**Do not put here:** Widget/App compatibility claims, Gemini-specific UI claims, real customer data, or
production enterprise runbooks.
**Update when:** The demo tools, role matrix, policy story, or expected operator flow changes.

This example is intentionally **regular MCP only**. It does not use MCP Apps widgets, custom components, or
media assets. It demonstrates how Noodle Seed can expose approved internal systems to AI assistants through
ordinary MCP tools while IT/security retain policy, audit, disablement, and secret-control boundaries.

Capability slots: **enterprise governed internal connectivity**, regular MCP tools, static and
parameterized resources, MCP prompts, role-shaped outputs, and high-risk action gating without widgets.

## Synthetic Systems

- **Directory/HR:** `lookup_employee` returns public directory fields and redacts HR-only fields unless the
  synthetic `role_context` is `hr_admin`.
- **Support/CRM:** `search_cases`, `get_case_detail`, and `draft_customer_reply` support customer case triage
  while redacting engineering notes unless `role_context` is `support_engineering`.
- **Finance:** `lookup_invoice`, `check_approval_policy`, `prepare_approval_packet`, and `approve_invoice`
  show high-risk action gating. Vendor bank details are never returned to model-visible output.
- **Resources/prompts:** `policy://internal-ops-demo`, `employee://{employee_id}`, `case://{case_id}`,
  `customer_safe_incident_update`, and `invoice_approval_brief` cover the regular MCP resource and prompt
  surface without adding an App widget.

`role_context` is demo input used to show field shaping. It is not an authorization boundary. Real
authorization and disablement are demonstrated by Noodle access modes, managed policy admission, and audit.

## Local Checks

```bash
noodle validate examples/internal-ops-demo/src/server.ts
noodle dev examples/internal-ops-demo/src/server.ts
```

Use any MCP client against the local `noodle dev` endpoint, or use the hosted deploy flow for an org-scoped
demo.

When an installed Noodle Developer plugin manages the workflow, its coding agent still authors and tests
this source. It invokes the pinned plugin launcher for every CLI step, parses `deploy --json`, and hands the
returned deployment ID to the remote `noodle-developer.inspect_deployment` tool. If the Cloud evidence needs
diagnosis, it follows with `noodle-developer.diagnose_app`; neither remote operation replaces local source
authoring.

## Hosted Demo Shape

```bash
noodle link --org demo --app internal-ops-demo --env prod
noodle deploy examples/internal-ops-demo/src/server.ts --access org-members
```

Useful model prompts:

- "Look up Fatima Khan's team and manager."
- "Search high-priority Acme Retail support cases and draft a customer-safe update."
- "Can I approve invoice inv-9001? Prepare the approval packet first."
- "Try approving inv-9001 without confirmation, then explain why it was refused."
- "Read case://case-7301 and use customer_safe_incident_update for a customer-safe message."

Operator proof points live in
an operations runbook that is internal to the Noodle Seed team.

## Operator Safety Note

Billing-account bootstrap is a platform-operator workflow, not app logic in this example. Super-admins can
inventory legacy organizations with `noodle billing migration preview --json`; the command is read-only and
there is no apply command. Keep real owner/app mapping files outside the repository, classify every
organization, treat owner subjects as `https://accounts.google.com` identities, inventory archived apps too,
assert the exact account and link version for already-linked organizations, and resolve every reported blocker
before a future cutover. See the
the billing bootstrap migration runbook, which is internal to the Noodle Seed team.
