# API call record retention

Every call through the pay-per-call proxy (`/api/:id/*`) writes one row to
`api_calls`. These rows feed provider stats, the recent-calls view, payer
history, popularity ranking, refunds and webhooks. They also describe who
called what, so ZentrixPay keeps as little as it can, for a bounded time.
The row stores only identifiers, payer/charge/settlement data, the minimized
route, response/timing data, refund state and its creation time; webhook
delivery details are stored separately in `webhook_deliveries`.

## What is stored

| Field                            | Kept          | Why                                                                                                                         |
| -------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `id`                             | yes           | Call id; used for refunds and webhook event ids                                                                             |
| `api_id`                         | yes           | Which API was called                                                                                                        |
| `payer_address`                  | yes           | Payer's Stellar address, as it appears on-chain in the settlement. Needed for refunds, unique-payer stats and payer history |
| `amount`, `charged`              | yes           | Price and whether the call was charged; stats and revenue                                                                   |
| `tx_hash`                        | yes           | Settlement transaction (public on-chain)                                                                                    |
| `refund_*`                       | yes           | Refund state for charged calls                                                                                              |
| `method`                         | yes           | HTTP method                                                                                                                 |
| `path`                           | **minimized** | Route shape only; see below                                                                                                 |
| `response_status`, `duration_ms` | yes           | Reliability and latency stats                                                                                               |
| `created_at`                     | yes           | Drives retention and time-based stats                                                                                       |

Never stored: query strings, request and response headers and bodies, caller
IP addresses, and the provider's upstream secret.

### Path minimization

The stored `path` is the part after the API's base path, reduced to a route
shape before the row is written (`server/src/lib/callPath.ts`):

- the query string and fragment are dropped,
- segments that look like identifiers are replaced:
  - email addresses → `:email`
  - UUIDs → `:uuid`
  - numbers of 6+ digits (card, phone, account numbers, dates) → `:number`
  - opaque tokens of 20+ characters mixing letters and digits (API keys,
    hashes, JWT-like strings, Stellar addresses) → `:token`
- the result is capped at 256 characters.

Short ids (`/items/42`), versions (`/v2`) and readable slugs
(`/weather-forecast-2026`) are kept, so providers still see which endpoints are
used. For example `/users/jane@example.com/cards/4111111111111111?expand=1` is
stored as `/users/:email/cards/:number`.

Rows written before this change keep their full path until they expire.

## How long rows are kept

Rows older than `API_CALL_RETENTION_DAYS` (default **180**) are deleted by a
background job in the server (`server/src/workers/apiCallRetentionWorker.ts`):

| Variable                         | Default   | Meaning                                                                                      |
| -------------------------------- | --------- | -------------------------------------------------------------------------------------------- |
| `API_CALL_RETENTION_DAYS`        | `180`     | Age after which a row is deleted. `0` keeps rows forever. Other values must be at least `90` |
| `API_CALL_RETENTION_INTERVAL_MS` | `3600000` | How often the job runs (`0` disables it)                                                     |
| `API_CALL_RETENTION_BATCH_SIZE`  | `1000`    | Rows deleted per statement, so a backlog is cleared without long locks                       |

The job runs at startup and then on the interval, in every replica. A run
deletes at most 100 batches; anything left is picked up by the next run.

The 90-day minimum keeps every feature that reads `api_calls` correct: the
provider time-series reaches back 90 days and popularity ranking 7 days.

## What changes once a row expires

- Before rows are purged, they are aggregated into a daily rollup table
  (`api_daily_rollups`) tracking calls, charged calls, revenue, duration, refunds,
  and unique payers per API per day.
- Minimal financial fields for charged calls (`amount`, `payer_address`,
  `tx_hash`, and refund state) are preserved in `api_call_financial_records`
  for accounting history (#283).
- Lifetime totals in API statistics (`calls`, `revenue`, `uniquePayers`, `netRevenue`)
  and provider analytics are computed from rollups plus recent rows, keeping
  totals identical before and after purges.
- The call can no longer be refunded through ZentrixPay once purged from active
  records. Providers who want to refund should do so within the window (the
  payment itself remains visible on-chain through `tx_hash`).
- Payer recent call history no longer lists detailed individual purged calls.

On-chain data (settlement transactions, receipts) is public and outside this
policy.
