import { connector, server, tool, z } from '@noodleseed/one';

const apiNinjas = connector('api_ninjas')
  .version('1.0.0')
  .http({
    baseUrl: 'https://api.api-ninjas.com',
    allowedOrigins: ['https://api.api-ninjas.com'],
    auth: {
      kind: 'apiKey',
      header: 'X-Api-Key',
      secret: 'API_NINJAS_KEY',
    },
    operations: {
      fact_of_the_day: {
        type: 'read',
        method: 'GET',
        path: '/v1/factoftheday',
        output: {
          type: 'object',
          properties: { fact: { type: 'string' } },
          additionalProperties: false,
        },
        response: {
          fact: '${response[0].fact}',
        },
      },
      random_fact: {
        type: 'read',
        method: 'GET',
        path: '/v1/facts',
        output: {
          type: 'object',
          properties: { fact: { type: 'string' } },
          additionalProperties: false,
        },
        response: {
          fact: '${response[0].fact}',
        },
      },
    },
  });

export default server(
  'api_ninjas_facts',
  { title: 'API Ninjas Facts', version: '1.0.0', use: { api: apiNinjas } },
  [
  tool('fact_of_the_day', {
    description: 'Return the API Ninjas fact of the day using a broker-managed API key.',
    input: z.object({}),
    output: z.object({
      fact: z.string(),
    }),
    fulfil: ({ connectors }) => {
      const result = connectors.api.factOfTheDay({});
      return { fact: result.fact };
    },
  }),
  tool('random_fact', {
    description: 'Return a random API Ninjas fact using a broker-managed API key.',
    input: z.object({}),
    output: z.object({
      fact: z.string(),
    }),
    fulfil: ({ connectors }) => {
      const result = connectors.api.randomFact({});
      return { fact: result.fact };
    },
  }),
  ],
);
