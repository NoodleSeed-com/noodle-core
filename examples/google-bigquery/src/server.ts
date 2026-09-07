import {
  annotations,
  bind,
  connection,
  connector,
  googleWorkloadIdentity,
  server,
  tool,
  variable,
  z,
} from '@noodleseed/one';

const BIGQUERY_ORIGIN = 'https://bigquery.googleapis.com';
const BIGQUERY_READONLY = 'https://www.googleapis.com/auth/bigquery.readonly';

const bigquery = connector('google_bigquery')
  .version('1.0.0')
  .http({
    baseUrl: BIGQUERY_ORIGIN,
    allowedOrigins: [BIGQUERY_ORIGIN],
    credentialProfiles: { google_wif: { kind: 'bearer' } },
    operations: {
      query: {
        type: 'read',
        method: 'POST',
        path: '/bigquery/v2/projects/${args.project_id}/queries',
        input: z.object({
          project_id: z.string().min(1),
          query: z.string().min(1),
          max_results: z.number().int().min(1).max(1000).optional(),
        }),
        output: z.object({
          job_complete: z.boolean().optional(),
          schema: z.unknown().optional(),
          rows: z.array(z.unknown()).optional(),
          total_rows: z.string().optional(),
        }),
        request: {
          query: '${args.query}',
          useLegacySql: false,
          maxResults: '${args.max_results}',
        },
        response: {
          job_complete: '${response.jobComplete}',
          schema: '${response.schema}',
          rows: '${response.rows}',
          total_rows: '${response.totalRows}',
        },
        credentials: {
          profiles: ['google_wif'],
          scopes: [BIGQUERY_READONLY],
          audience: BIGQUERY_ORIGIN,
        },
      },
    },
  });

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

export default server(
  'google_bigquery',
  {
    title: 'Google BigQuery Reader',
    version: '1.0.0',
    use: {
      bigquery: bind(bigquery, { profile: 'google_wif', connection: google }),
    },
    instructions:
      'Run read-only GoogleSQL queries in the configured customer BigQuery project. Never invent project, dataset, or table names.',
  },
  [
    tool('query_bigquery', {
      title: 'Query BigQuery',
      description:
        'Run one read-only GoogleSQL query in an explicitly named Google Cloud project and return the typed BigQuery rows.',
      input: z.object({
        project_id: z.string().min(1).meta({ title: 'Google Cloud project' }),
        query: z.string().min(1).meta({ title: 'GoogleSQL query' }),
        max_results: z.number().int().min(1).max(1000).optional(),
      }),
      output: z.object({
        job_complete: z.boolean(),
        schema: z.unknown().optional(),
        rows: z.array(z.unknown()),
        total_rows: z.string().optional(),
      }),
      annotations: annotations.readOnly(),
      fulfil({ input, connectors }) {
        const result = connectors.bigquery.query({
          project_id: input.project_id,
          query: input.query,
          max_results: input.max_results,
        });
        return {
          job_complete: result.job_complete,
          schema: result.schema.optional(),
          rows: result.rows,
          total_rows: result.total_rows.optional(),
        };
      },
    }),
  ],
);
