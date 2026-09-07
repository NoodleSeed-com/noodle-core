# External credential provider conformance kit

`@noodle-borg/external-credential-provider` contains the strict public wire schemas and conformance helpers
for Noodle Seed deployment-owned external credential exchange. The source is Apache-2.0 and included in the
public Noodle Core projection.

The package is currently a private workspace/source kit, not a standalone npm release. Provider authors may
implement the public contract in the connector specification, or use this
source inside the Noodle Core workspace. Do not instruct customers to run
`pnpm add @noodle-borg/external-credential-provider`; independent publication awaits customer proof and a
separate release-system decision.

The kit owns only request/response schemas, workload-assertion signing and verification, atomic replay-store
interfaces, a fake provider, and conformance checks. It does not own provider enrollment, account CRUD,
refresh-token custody, hosted endpoint registration, or provider-specific SDKs.

`InMemoryAssertionReplayStore` is local/test-only. Production providers must inject durable shared atomic
replay storage so one-time assertion consumption survives multiple instances and process restarts.
