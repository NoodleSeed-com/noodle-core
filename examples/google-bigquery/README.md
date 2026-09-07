# Google BigQuery — keyless deployed-server authentication

This flagship owns the Google Workload Identity Federation capability slot: a deployed Noodle Seed server
calls BigQuery with hourly short-lived Google credentials and never uploads or stores a service-account JSON
key. The same `googleWorkloadIdentity(...)` connection works for other Google REST APIs when their connector
operations declare the exact Google OAuth scopes and `https://*.googleapis.com` audience they require.

The developer authors only TypeScript:

```ts
const google = connection(
  'customer_google_cloud',
  googleWorkloadIdentity({
    provider: variable('GOOGLE_WIF_PROVIDER'),
    access: {
      kind: 'serviceAccountImpersonation',
      serviceAccount: variable('GOOGLE_SERVICE_ACCOUNT'),
    },
  }),
);

use: {
  bigquery: bind(bigquery, { profile: 'google_wif', connection: google }),
}
```

`GOOGLE_WIF_PROVIDER` is the non-secret provider resource
`projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL/providers/PROVIDER`.
`GOOGLE_SERVICE_ACCOUNT` is the non-secret email of the customer service account that Google will
impersonate. The private key does not exist in Noodle.

## Complete operator setup

After creating or joining the target Noodle organization, prepare the environment's stable workload identity.
This can run before the first deploy and prints copyable Google Cloud and managed-variable commands:

```sh
noodle auth google prepare \
  --org acme \
  --app google-bigquery \
  --env prod \
  --project-number 123456789012 \
  --pool noodle-prod \
  --provider google-bigquery \
  --service-account bigquery-reader@customer-project.iam.gserviceaccount.com
```

The command asks for every Google-specific value Noodle cannot infer, creates no Google resources itself,
and prints:

- the required API-enablement, workload-pool, and OIDC-provider commands;
- the exact issuer, attribute mapping, tenant condition, and federated principal URI;
- the least-privilege `roles/iam.workloadIdentityUser` service-account binding;
- the exact `noodle variables set ... --runtime cloud` commands.

In the customer project, grant the service account only the data permissions the server needs. For this
read-only example, use dataset-level `roles/bigquery.dataViewer` and project-level
`roles/bigquery.jobUser` so it can create query jobs; do not grant project Owner or Editor.

After applying the printed Google and Noodle commands, deploy the authored server and validate a real token
exchange without running the `query_bigquery` business tool:

```sh
noodle deploy --access owner-only
noodle auth google doctor --org acme --app google-bigquery --env prod
```

The broker signs a one-hour RS256 OIDC subject token with the platform signing key, exchanges it only at
Google STS, optionally calls IAM Credentials `generateAccessToken`, and caches the final binding-scoped token
until five minutes before expiry. Revocation immediately stops Noodle from issuing or reusing credentials:

```sh
noodle auth google revoke --org acme --app google-bigquery --env prod
```

An already-issued Google token can remain usable until its short expiry. Remove the customer-side IAM
principal binding as defense in depth. Re-preparing after revocation creates a new subject, so the old
Google IAM binding cannot silently become valid again.

## Direct federation instead of impersonation

Where the target Google API supports direct federated principals, omit the service account:

```ts
googleWorkloadIdentity({
  provider: variable('GOOGLE_WIF_PROVIDER'),
  access: { kind: 'direct' },
});
```

Run `noodle auth google prepare` without `--service-account`, then grant the printed federated principal the
least-privilege role directly on the target resource.

## Local validation

Compilation and tests need no Google credentials:

```sh
noodle validate
noodle test
```

For a local run that needs the declared provider values, the exact project-root `.env` can contain
`GOOGLE_WIF_PROVIDER` and `GOOGLE_SERVICE_ACCOUNT`; `noodle dev` uses matching declarations only as a
read-only fallback, and scoped `.env.noodle` values override it. Never commit or ask an agent to read either
file. Interactive deploy can offer a default-No import of matching missing names to the visible target;
non-interactive and plugin deploys keep the value-free `noodle variables set ... --from-env` recovery path.
