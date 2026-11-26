# API Examples

curl examples for the core ZentrixPay gateway workflows. Replace placeholder values (`<...>`) with real values.

```
BASE=http://localhost:4021   # or your deployed server URL
API_KEY=zp_...               # from the POST /publishers response
API_ID=<api-id>              # from POST /apis or GET /apis
```

For a guided, end-to-end walkthrough see the [Provider Quickstart](provider-quickstart.md). For the payment handshake in detail see the [curl 402 walkthrough](curl-402-walkthrough.md).

---

## Health check

```bash
curl -s $BASE/health
curl -s $BASE/health/ready   # also checks the database
```

---

## Providers

### Register a provider

```bash
curl -s -X POST $BASE/publishers \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Alice",
    "email": "alice@example.com",
    "walletAddress": "GB6LGS25BCTVQSIXNCXDTRH5OHKBXFB4CPCNPOCFXCZJVLFAJNL5KHM"
  }' | jq .
```

Expected response (`201 Created`):

```json
{
  "id": "clxyz1234",
  "name": "Alice",
  "email": "alice@example.com",
  "walletAddress": "GB6LGS25BCTVQSIXNCXDTRH5OHKBXFB4CPCNPOCFXCZJVLFAJNL5KHM",
  "apiKey": "zp_abc123...",
  "createdAt": "2026-06-24T13:00:00.000Z"
}
```

> The `apiKey` is returned **once**. Store it — it cannot be retrieved again. Keys issued before the `zp_` prefix (starting with `mv_`) keep working.

### Get own profile

```bash
curl -s $BASE/publishers/me -H "x-api-key: $API_KEY" | jq .
```

### Rotate the API key

```bash
curl -s -X POST $BASE/publishers/me/rotate-key -H "x-api-key: $API_KEY" | jq .
```

The old key stops working immediately.

### Analytics across all of your APIs

```bash
curl -s $BASE/publishers/me/analytics -H "x-api-key: $API_KEY" | jq .
```

```json
{
  "totals": {
    "apis": 2,
    "calls": 15,
    "chargedCalls": 12,
    "revenue": "1.2",
    "currency": "USDC"
  },
  "apis": [
    {
      "id": "api-1",
      "name": "Weather",
      "archivedAt": null,
      "calls": 10,
      "chargedCalls": 8,
      "revenue": "0.8"
    },
    {
      "id": "api-2",
      "name": "Quotes",
      "archivedAt": null,
      "calls": 5,
      "chargedCalls": 4,
      "revenue": "0.4"
    }
  ]
}
```

Archived APIs are included, since their calls were paid for. A provider with no APIs or calls gets zeros and an empty `apis` list.

---

## Managing APIs

### Register an API

```bash
curl -s -X POST $BASE/apis \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Weather",
    "description": "Current conditions by city",
    "upstreamUrl": "https://weather.example.com/v1",
    "price": "0.01",
    "allowedMethods": ["GET"],
    "upstreamHeader": { "name": "Authorization", "value": "Bearer <upstream-secret>" },
    "tags": ["weather"]
  }' | jq .
```

The upstream secret is encrypted at rest and never returned. The response includes the ownership check to complete before the API is listed.

### Verify ownership

Serve the token from the response at `/.well-known/zentrixpay.txt` on the upstream host, then:

```bash
curl -s -X POST $BASE/apis/$API_ID/verify-ownership -H "x-api-key: $API_KEY" | jq .
```

### List your APIs

```bash
curl -s $BASE/publishers/me/apis -H "x-api-key: $API_KEY" | jq .
```

### Update an API

```bash
curl -s -X PATCH $BASE/apis/$API_ID \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "price": "0.02" }' | jq .
```

### Archive an API

```bash
curl -s -X DELETE $BASE/apis/$API_ID -H "x-api-key: $API_KEY" | jq .
```

Archived APIs are hidden everywhere but keep their call history.

### Per-API stats

```bash
curl -s $BASE/apis/$API_ID/stats -H "x-api-key: $API_KEY" | jq .
curl -s "$BASE/apis/$API_ID/stats/time-series?days=30" -H "x-api-key: $API_KEY" | jq .
```

---

## Browsing the catalog

```bash
curl -s "$BASE/apis?q=weather&tag=weather&sort=popular&limit=20" | jq .
curl -s $BASE/apis/$API_ID | jq .
curl -s $BASE/apis/$API_ID/openapi.json | jq .
```

`sort` is one of `newest` (default), `price_asc`, `price_desc`, `popular`.

---

## Calling a paid API

Every call goes through the proxy at `/api/:id/<path>`:

```bash
curl -i $BASE/api/$API_ID/current?city=Lagos
```

#### Proxy path requirements and boundary validation

The proxy path appended after `/api/:id` must remain strictly within the provider's configured upstream boundary:

- Traversal sequences (`..`, `.`, `%2e`, `%252e`), path separator smuggling (`/`, `\`, `%2f`, `%5c`), and null bytes (`\0`, `%00`) are strictly forbidden.
- Any attempt to escape the API's configured upstream origin or base path is rejected with `400 Bad Request` and error code `invalid_path`.
- Traversal attempts are blocked before request buffering, before upstream forwarding, and before any payment is deducted or charged.

Without payment the gateway answers `402 Payment Required` with the price and payee in the `PAYMENT-REQUIRED` header. Use an x402 client to pay and retry automatically — see [Calling ZentrixPay APIs from JavaScript](call-from-javascript.md).

### Bulk OpenAPI import

Providers can preview and then confirm groups of operations from an OpenAPI 3 JSON or YAML document. Both endpoints require `x-api-key`; the document may be sent as JSON (`document` or `openapiSpec`) or as a multipart file field named `document`.

```bash
curl -s -X POST $BASE/apis/import/preview -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary "{\"document\":$(jq -Rs . openapi.yaml)}" | jq .
```

The preview response is `{ "groups": [{ "key", "name", "serverUrl", "tags", "operations", "spec" }], "errors": [] }`. Operations are grouped by tag, with untagged operations grouped under the document server. Confirm selected group keys with `POST /apis/import` and `{ "document": <text>, "groups": ["tag"], "defaults": { "price": "0.01", "walletAddress": "G...", "description": "..." } }`. The response is `{ "imported": [...], "skipped": [...] }`; repeated confirmations are idempotent and all new groups are inserted transactionally. The Provider Dashboard uses the same preview/confirm flow without displaying or returning upstream secrets.

### Receipts for a payer

```bash
curl -s "$BASE/payers/<G...address>/calls?limit=20" | jq .
```
