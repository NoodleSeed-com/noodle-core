# Credit Union Refinance Finder

**Owns:** The credit-union MCP App example for detecting a recurring external auto-loan payment from a
member checking account, estimating a refinance opportunity, and routing the next outreach step through a
React widget.
**Read when:** You need a simple financial-services MCP App example with synthetic member data, app-only
helper tools, caller-scoped workspace state, and progressive fallback output.
**Do not put here:** Real member data, credit bureau data, underwriting decisions, production compliance
advice, secrets, or live loan-origination integrations.
**Update when:** The example's capability slot, widget workflow, or synthetic refinance data model changes.

Capability slot: financial-services member-opportunity MCP App. This example is fully synthetic and does not
connect to a core banking system, transaction aggregator, credit bureau, or loan-origination system.

## What It Shows

| Capability | Example |
| :--- | :--- |
| Public entry tool | `open_refinance_finder` returns fallback member/refinance data and renders the React widget |
| App-only helper tools | `list_members`, `detect_recurring_auto_loans`, `estimate_refinance_offer`, `sync_refi_workspace` |
| Synthetic member insight | Checking balance, deposits, member-permissioned recurring payment signals, estimated APR comparison, and savings |
| Caller-scoped state | `refi_workspace` stores selected member, active dashboard tab, selected outreach plays, and revision metadata |
| Host action | `Open LOS review` opens only the allowlisted `https://creditunion.example.com` origin |
| Progressive enhancement | Non-Apps hosts receive a useful structured summary and an explicit synthetic-data notice |

## Local Author Loop

```sh
pnpm test
pnpm validate
pnpm dev
```

In another terminal:

```sh
noodle tools list
noodle tools call open_refinance_finder --args '{}'
noodle tools call summarize_refinance_opportunities --args '{}'
```

For Apps metadata conformance, start `noodle dev`, copy the loopback MCP endpoint, then run:

```sh
npx @mcpjam/cli@latest apps conformance --url http://127.0.0.1:<port>/o/demo/credit-union/mcp --quiet --format json
```

## Deploy

```sh
noodle link --org demo --app credit-union
noodle deploy --access owner-only
noodle open
```

This example has no connector secrets. Savings, APRs, confidence values, and member records are illustrative
demo values; the widget frames any refinance as an invitation to review, not a credit approval or final loan
offer.
