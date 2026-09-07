import { connector, secret, server, tool, z } from '@noodleseed/one';

const apiNinjas = connector('api_ninjas_bitcoin')
  .version('1.0.0')
  .http({
    baseUrl: 'https://api.api-ninjas.com',
    allowedOrigins: ['https://api.api-ninjas.com'],
    auth: {
      kind: 'apiKey',
      header: 'X-Api-Key',
      secret: secret('API_NINJAS_API_KEY'),
    },
    operations: {
      latest_bitcoin_market: {
        type: 'read',
        method: 'GET',
        path: '/v1/bitcoin',
        output: z.object({ raw: z.unknown() }),
        response: {
          raw: '${response}',
        },
      },
    },
  });

const marketFormatter = connector('bitcoin_market_formatter')
  .version('1.0.0')
  .compute('normalize', {
    type: 'read',
    input: z.object({ raw: z.unknown() }),
    output: z.object({
      price_usd: z.string(),
      timestamp: z.number(),
      price_change_24h_usd: z.string(),
      price_change_24h_percent: z.string(),
      high_24h_usd: z.string(),
      low_24h_usd: z.string(),
      volume_24h_btc: z.string(),
    }),
    run: (input) => {
      const raw = input.raw as Record<string, unknown>;
      return {
        price_usd: String(raw.price),
        timestamp: Number(raw.timestamp),
        price_change_24h_usd: String(raw['24h_price_change']),
        price_change_24h_percent: String(raw['24h_price_change_percent']),
        high_24h_usd: String(raw['24h_high']),
        low_24h_usd: String(raw['24h_low']),
        volume_24h_btc: String(raw['24h_volume']),
      };
    },
  });

export default server(
  'bitcoin_price',
  {
    title: 'Bitcoin Price',
    version: '1.0.0',
    use: { bitcoin: apiNinjas, formatter: marketFormatter },
    branding: {
      name: 'Bitcoin Price',
      accent: '#F7931A',
      radius: 'md',
      density: 'comfortable',
    },
  },
  [
    tool('get_bitcoin_market', {
      description:
        'Return the latest Bitcoin price in USD plus 24-hour price change, high, low, and volume from API Ninjas.',
      input: z.object({}),
      output: z.object({
        price_usd: z.string(),
        timestamp: z.number(),
        price_change_24h_usd: z.string(),
        price_change_24h_percent: z.string(),
        high_24h_usd: z.string(),
        low_24h_usd: z.string(),
        volume_24h_btc: z.string(),
      }),
      fulfil: ({ connectors }) => {
        const upstream = connectors.bitcoin.latest_bitcoin_market({});
        const market = connectors.formatter.normalize({ raw: upstream.raw });
        return {
          price_usd: market.price_usd,
          timestamp: market.timestamp,
          price_change_24h_usd: market.price_change_24h_usd,
          price_change_24h_percent: market.price_change_24h_percent,
          high_24h_usd: market.high_24h_usd,
          low_24h_usd: market.low_24h_usd,
          volume_24h_btc: market.volume_24h_btc,
        };
      },
    }),
  ],
);
