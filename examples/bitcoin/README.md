# Bitcoin Price

A small authenticated HTTP connector example for the API Ninjas Bitcoin endpoint. The
`get_bitcoin_market` tool returns the latest Bitcoin price in USD and the 24-hour price change, high, low,
and traded volume.

Capability slots: API-key HTTP connector authoring, custom auth header injection, and sandboxed compute
normalization of upstream JSON fields with numeric-leading names.

The public developer entrypoint is [`src/server.ts`](src/server.ts). It uses a managed API-key secret; the
API Ninjas key never belongs in source, generated manifests, runtime artifacts, prompts, or logs.

## Provision

1. Create an API Ninjas API key with access to the Bitcoin endpoint.
2. Export the value only in your shell while configuring Noodle Seed Cloud:

```bash
export API_NINJAS_API_KEY='...'
```

## Validate

```bash
noodle validate examples/bitcoin/src/server.ts
```

## Run locally

From the repo root, with the workspace built (`pnpm build`):

```bash
: # 1. boot the local loopback dev server
node packages/cli/dist/cli.js dev examples/bitcoin/src/server.ts --app bitcoin

: # 2. in another shell, call the printed local endpoint
URL=http://127.0.0.1:<port>/o/local/bitcoin/dev/mcp
curl -s "$URL" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-11-25' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_bitcoin_market","arguments":{}}}'
```

## Deploy

```bash
noodle secrets set API_NINJAS_API_KEY --scope env --from-env API_NINJAS_API_KEY
noodle deploy examples/bitcoin/src/server.ts --app bitcoin --env prod --access owner-only
```

## Tool

- `get_bitcoin_market`: fetches `/v1/bitcoin` from API Ninjas and normalizes the response into stable,
  schema-typed field names such as `price_usd`, `price_change_24h_percent`, and `volume_24h_btc`.

Example result (live or delayed data depending on the API Ninjas plan):

```json
{
  "price_usd": "94962.21000000",
  "timestamp": 1736824504,
  "price_change_24h_usd": "849.92000000",
  "price_change_24h_percent": "0.903",
  "high_24h_usd": "95222.00000000",
  "low_24h_usd": "89438.45000000",
  "volume_24h_btc": "26.39660000"
}
```
