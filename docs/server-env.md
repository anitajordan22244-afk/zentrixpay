# Server environment variables

All variables live in `server/.env` (never committed). Copy `server/.env.example`
and fill in each value.

| Variable                              | Required | Default                            | Description                                                                                                                                                     |
| ------------------------------------- | -------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                            | no       | `development`                      | Runtime environment (`development`, `production`, `test`)                                                                                                       |
| `PORT`                                | no       | `4021`                             | HTTP listen port                                                                                                                                                |
| `BASE_URL`                            | no       | `http://localhost:4021`            | Public base URL of the server                                                                                                                                   |
| `WEB_APP_URL`                         | no       | `http://localhost:5173`            | Web app URL (used for CORS / redirects)                                                                                                                         |
| `ALLOWED_ORIGINS`                     | no       | —                                  | Comma-separated browser origins allowed in production (defaults to `WEB_APP_URL`)                                                                               |
| `STELLAR_NETWORK`                     | no       | `testnet`                          | Deployment network selector (`testnet` or `mainnet`). Fills defaults for RPC, USDC, and x402 network when individual vars are omitted                           |
| `NETWORK`                             | no       | from `STELLAR_NETWORK`             | x402 network id (`stellar:testnet` or `stellar:pubnet`; `stellar:mainnet` is accepted as an alias for pubnet)                                                   |
| `FACILITATOR_URL`                     | no       | `https://www.x402.org/facilitator` | x402 facilitator endpoint for payment verification/settlement                                                                                                   |
| `FACILITATOR_HEALTH_TIMEOUT_MS`       | no       | `2000`                             | Timeout for the read-only facilitator check in `/health/ready` (`GET /supported`; never starts a payment)                                                       |
| `READINESS_REQUIRE_FACILITATOR`       | no       | `true`                             | When `true`, an unavailable facilitator makes `/health/ready` return 503; `false` reports it without failing readiness                                          |
| `USDC_CONTRACT_ID`                    | no       | from `STELLAR_NETWORK`             | Soroban USDC Stellar Asset Contract for the selected network                                                                                                    |
| `SOROBAN_RPC_URL`                     | no       | from `STELLAR_NETWORK`             | Soroban RPC endpoint for on-chain registry reads/writes                                                                                                         |
| `DATABASE_URL`                        | **yes**  | —                                  | Postgres connection string                                                                                                                                      |
| `DB_POOL_MAX`                         | no       | `10`                               | Max Postgres pool connections (1–200). Keep below the database's connection limit divided by instance count                                                     |
| `DB_STATEMENT_TIMEOUT_MS`             | no       | `30000`                            | Postgres `statement_timeout`: queries running longer are cancelled (100–600000)                                                                                 |
| `DB_SLOW_QUERY_MS`                    | no       | `500`                              | Postgres `log_min_duration_statement`: statements slower than this are logged (0–600000)                                                                        |
| `REGISTRY_CONTRACT_ID`                | **yes**  | —                                  | Deployed registry contract ID (APIs are registered on-chain here)                                                                                               |
| `REGISTRY_SECRET_KEY`                 | **yes**  | —                                  | Secret key of the registry deployer / owner account                                                                                                             |
| `RATE_LIMIT_PUBLISH_IP_MAX`           | no       | `20`                               | Max API registrations per IP per window                                                                                                                         |
| `RATE_LIMIT_PUBLISH_IP_WINDOW_MS`     | no       | `60000`                            | API registration IP rate-limit window in ms                                                                                                                     |
| `RATE_LIMIT_PUBLISH_WALLET_MAX`       | no       | `10`                               | Max API registrations per provider wallet per window                                                                                                            |
| `RATE_LIMIT_PUBLISH_WALLET_WINDOW_MS` | no       | `3600000`                          | API registration wallet rate-limit window in ms                                                                                                                 |
| `RATE_LIMIT_REGISTER_IP_MAX`          | no       | `5`                                | Max publisher registrations (`POST /publishers`) per IP per window                                                                                              |
| `RATE_LIMIT_REGISTER_IP_WINDOW_MS`    | no       | `3600000`                          | Publisher registration IP rate-limit window in ms                                                                                                               |
| `REDIS_URL`                           | no       | —                                  | Shared Redis rate-limit store. Without it, rate limits are process-local; production startup logs a warning.                                                    |
| `REQUEST_TIMEOUT_MS`                  | no       | `30000`                            | Per-request timeout; slow upstreams return 503                                                                                                                  |
| `GRACEFUL_SHUTDOWN_TIMEOUT_MS`        | no       | `10000`                            | Max time to drain in-flight requests on SIGTERM/SIGINT                                                                                                          |
| `IDEMPOTENCY_TTL_MS`                  | no       | `86400000`                         | How long a publish Idempotency-Key is remembered (24h)                                                                                                          |
| `API_CALL_RETENTION_DAYS`             | no       | `180`                              | Days an API call record is kept before deletion. `0` keeps records forever; otherwise must be at least `90`. See [api-call-retention.md](api-call-retention.md) |
| `API_CALL_RETENTION_INTERVAL_MS`      | no       | `3600000`                          | How often expired API call records are purged (`0` disables the job)                                                                                            |
| `API_CALL_RETENTION_BATCH_SIZE`       | no       | `1000`                             | Max API call records deleted per statement (1–10000)                                                                                                            |
| `API_CALL_OUTBOX_DIR`                 | no       | `./data/api-call-outbox`           | Spool for API call records whose database write failed; use a persistent volume. See [api-call-recovery.md](api-call-recovery.md)                               |
| `API_CALL_RECOVERY_INTERVAL_MS`       | no       | `30000`                            | How often spooled API call records are retried (`0` disables the worker)                                                                                        |

## API gateway

These control the pay-per-call proxy (`/api/:id/*`), upstream health checks and
provider webhooks.

| Variable                           | Required | Default    | Description                                                                                                                                                   |
| ---------------------------------- | -------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UPSTREAM_SECRET_KEY`              | no       | —          | 64 hex chars (32 bytes). Encrypts providers' upstream headers, query secrets and webhook secrets at rest. Without it, APIs cannot be registered with a secret |
| `PROXY_MAX_REQUEST_BODY`           | no       | `5mb`      | Largest request body forwarded to an upstream                                                                                                                 |
| `PROXY_MAX_RESPONSE_BYTES`         | no       | `10485760` | Largest upstream response accepted (held in memory until payment settles)                                                                                     |
| `PROXY_DEFAULT_TIMEOUT_MS`         | no       | `15000`    | Upstream timeout when an API does not set its own                                                                                                             |
| `PROXY_MAX_TIMEOUT_MS`             | no       | `25000`    | Ceiling for a per-API timeout                                                                                                                                 |
| `PROXY_IDEMPOTENCY_TTL_MS`         | no       | `3600000`  | How long a paid-call idempotency record is kept in Postgres                                                                                                   |
| `PROXY_IDEMPOTENCY_MAX_ENTRIES`    | no       | `1000`     | Entry cap for the in-memory idempotency store used by tests                                                                                                   |
| `PROXY_IDEMPOTENCY_MAX_BODY_BYTES` | no       | `262144`   | Largest response body kept for replay                                                                                                                         |
| `PROXY_ALLOW_PRIVATE_UPSTREAMS`    | no       | `false`    | Allow upstreams on private/loopback addresses (local development only)                                                                                        |
| `PROXY_API_CACHE_TTL_MS`           | no       | `5000`     | How long a proxied API's row is cached between DB lookups                                                                                                     |
| `HEALTH_CHECK_INTERVAL_MS`         | no       | `60000`    | How often APIs with a `healthPath` are pinged (`0` disables)                                                                                                  |
| `HEALTH_CHECK_TIMEOUT_MS`          | no       | `5000`     | Timeout for each health check                                                                                                                                 |
| `HEALTH_CHECK_FAILURE_THRESHOLD`   | no       | `3`        | Consecutive failures before an API is hidden from the catalog                                                                                                 |
| `WEBHOOK_TIMEOUT_MS`               | no       | `5000`     | Timeout for each provider webhook delivery                                                                                                                    |
| `WEBHOOK_MAX_ATTEMPTS`             | no       | `5`        | Delivery attempts per charged-call event                                                                                                                      |
| `WEBHOOK_RETRY_BASE_MS`            | no       | `1000`     | Retry delay base; attempt _n_ waits `WEBHOOK_RETRY_BASE_MS * 4^n`                                                                                             |

## Legacy vault variables

`AGENT_SECRET_KEY`, `VAULT_REGISTRY_CONTRACT_ID`, `REGISTRY_CONTRACT_ID`,
`REGISTRY_SECRET_KEY`, `OPENROUTER_API_KEY`, the `VERIFICATION_*` and
`RATE_LIMIT_VERIFY_*` / `RATE_LIMIT_PUBLISH_*` variables, and the Supabase
storage settings belong to the old resource vault. The gateway does not use
them, but `server/src/config.ts` still validates the required ones at startup,
so they must be set until that code is removed.

## Mainnet values

Set `STELLAR_NETWORK=mainnet` (or set each variable explicitly). Required mainnet values:

| Variable                     | Mainnet value                                              |
| ---------------------------- | ---------------------------------------------------------- |
| `STELLAR_NETWORK`            | `mainnet`                                                  |
| `NETWORK`                    | `stellar:pubnet`                                           |
| `SOROBAN_RPC_URL`            | `https://soroban.stellar.org`                              |
| `USDC_CONTRACT_ID`           | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` |
| `VAULT_REGISTRY_CONTRACT_ID` | Your deployed mainnet vault-registry contract ID           |
| `REGISTRY_CONTRACT_ID`       | Your deployed mainnet registry contract ID                 |

Startup validation rejects mixed settings (for example, `STELLAR_NETWORK=testnet` with a mainnet Soroban RPC URL or USDC contract).
