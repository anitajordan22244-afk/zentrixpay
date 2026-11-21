# Operator runbook: gateway incidents

What to do when the pay-per-call gateway breaks in production. Each entry
covers how to **detect** the problem, how to **mitigate** it now, and what
to **follow up** on afterwards.

For first-time deployment, see [deployment-runbook.md](deployment-runbook.md).
For how a paid call flows, see [paid-call-pricing.md](paid-call-pricing.md).

## Signals you have

| Signal                                                     | Where               | What it tells you                                              |
| ---------------------------------------------------------- | ------------------- | -------------------------------------------------------------- |
| `GET /health`                                              | server              | Process is up                                                  |
| `GET /health/ready`                                        | server              | `checks.database` and `checks.sorobanRpc`; 503 if either fails |
| `x402_verify` / `x402_settle` log events, `phase: "error"` | server logs (pino)  | Facilitator calls failing                                      |
| `api_upstream_failed` (`kind`)                             | server logs         | Upstream blocked / timeout / too_large / network               |
| `api_call_record_failed`                                   | server logs         | Calls served but not written to `api_calls`                    |
| `request_timeout`                                          | server logs         | Requests hitting `REQUEST_TIMEOUT_MS`                          |
| `unhandled_error`                                          | server logs, Sentry | Anything that fell through to the 500 handler                  |
| `http_request_duration_seconds`, `db_pool_connections_*`   | `GET /metrics`      | Latency, DB pool pressure                                      |
| `api_calls` table                                          | Postgres            | Per-call status, `charged`, payer, duration                    |

A query worth keeping handy, the charged ratio over the last 15 minutes:

```sql
select count(*) as calls,
       count(*) filter (where charged) as charged,
       count(*) filter (where response_status >= 500) as errors_5xx
from api_calls
where created_at > now() - interval '15 minutes';
```

---

## Facilitator down

The x402 facilitator (`FACILITATOR_URL`, default
`https://www.x402.org/facilitator`) verifies and settles every payment. If it
is down, no paid call can complete.

**Detect**

- Spike in `x402_verify` or `x402_settle` logs with `phase: "error"`.
- Paid calls fail and the charged ratio in `api_calls` drops to near zero.
  Unpaid requests still get a normal `402`, because that response does not
  need the facilitator.
- `/health/ready` stays **green**. It does not probe the facilitator.
- Check the facilitator's status page, or `curl -i $FACILITATOR_URL` from the
  server host.

**Mitigate**

- Callers are not charged for failed calls
  ([ADR 0001](adr/0001-settle-after-response.md)), so this is an outage, not
  a money-loss incident for callers.
- **Settle failures cost providers.** Their upstream already served the call
  ([ADR 0001](adr/0001-settle-after-response.md), Consequences). If verify
  works but settle fails, tell affected providers.
- If another facilitator supports the same network and the `exact` Stellar
  scheme, set `FACILITATOR_URL` to it and restart. Confirm with one test call
  on testnet first.
- Otherwise, post a status notice and wait. Do not disable the paywall.

**Follow up**

- Add a facilitator probe to `/health/ready`, or a separate alert. Readiness
  should probably not fail on it, because that would pull every instance.
- Alert on the `x402_settle` error rate.
- Count calls where verify passed but settle failed, and share the count
  with affected providers.

---

## Stellar RPC degraded

`SOROBAN_RPC_URL` is used by the readiness probe and the on-chain registry.
The facilitator settles payments through its own Stellar connection, so a
degraded **gateway** RPC does not by itself stop paid calls. A degraded
**Stellar network** does.

**Detect**

- `/health/ready` returns `503` with `checks.sorobanRpc.status: "error"`
  (`checks.database` is ok).
- Registry routes slow down or time out (`request_timeout` on `/registry/*`).
- If settlement is also slow, `x402_settle` latency rises and
  `request_timeout` appears on `/api/*`.

**Mitigate**

- **Watch the load balancer first.** If it uses `/health/ready`, a bad RPC
  will mark every instance unready and take the whole gateway down, even
  though the proxy could still work. Point the LB health check at `/health`
  until the RPC recovers.
- Switch `SOROBAN_RPC_URL` to another provider for the same network and
  restart.
- If the Stellar network itself is degraded (check the Stellar status page),
  nothing local fixes it. Paid calls will fail or time out, and callers are
  not charged.

**Follow up**

- Decide whether `sorobanRpc` should be part of readiness for proxy-only
  instances.
- Configure a fallback RPC URL. The MCP server already supports this; see
  [mcp-rpc-failover.md](mcp-rpc-failover.md).

---

## Database full

Every proxied call inserts a row in `api_calls`, so this table is what fills
the disk.

**Detect**

- `api_call_record_failed` errors in the logs. Calls are still **served and
  charged**, but they are missing from stats.
- `unhandled_error` with Postgres errors such as `could not extend file` or
  `No space left on device`.
- `/health/ready` reports `checks.database: "error"` once reads fail too.
- Supabase dashboard: disk usage alerts.

**Mitigate**

1. Increase the disk in Supabase. This is the fastest fix, and Supabase can
   auto-grow on paid plans.
2. If that is not possible, export and delete old call rows:
   ```sql
   -- export first: \copy (select * from api_calls where created_at < now() - interval '90 days') to 'api_calls_old.csv' csv header
   delete from api_calls where created_at < now() - interval '90 days';
   vacuum (analyze) api_calls;
   ```
   Deleting rows changes the lifetime totals in `GET /apis/:id/stats`. Tell
   providers before you do it.
3. Rows that failed to record are lost. Their payments are on-chain, so they
   can be rebuilt from facilitator or Horizon history if needed.

**Follow up**

- Set a retention policy for `api_calls`, or roll old rows into daily totals.
- Alert on `api_call_record_failed` and on disk usage above 80 %.
- Consider partitioning `api_calls` by month
  ([ADR 0003](adr/0003-cuid2-identifiers.md), Consequences).

---

## Upstream abuse

A listed API is misusing the gateway: serving malware or phishing content,
reselling someone else's API, or behaving maliciously toward callers.

**Detect**

- Abuse reports from callers or third parties.
- `api_upstream_failed` with `kind: "blocked"` for one API. Its domain
  resolves to private addresses, which may be a DNS-rebinding attempt.
- Unusual patterns in `api_calls` for one `api_id`: high 2xx volume with tiny
  durations, or a flood of failures.

**Mitigate**

There is no admin endpoint yet. Use SQL.

1. Take the API off the catalog and the proxy right away:
   ```sql
   update apis set listed = false, ownership_verified_at = null where id = '<api_id>';
   ```
   The proxy returns `404` from the next request. Clearing
   `ownership_verified_at` stops the owner from re-listing with
   `PATCH { listed: true }` (it gets `409`). They could still serve the
   token again and re-verify.
2. To lock them out completely, invalidate the publisher's API key:
   ```sql
   update publishers set api_key_hash = 'revoked:' || id where id = (select publisher_id from apis where id = '<api_id>');
   ```
3. Keep the `apis` row and its `api_calls` rows as evidence. Do not delete
   them.

**Follow up**

- Add an operator-only `blocked` flag that verification cannot override, and
  an admin route to set it.
- Add a periodic ownership re-check
  ([ADR 0005](adr/0005-ownership-proof-well-known.md), Consequences).
- Document a takedown policy and a place to report abuse.

---

## Leaked provider key

Two different secrets can leak. Find out which one.

### A. The provider's ZentrixPay API key (`x-api-key`, `mv_…`)

With it, an attacker can change the provider's APIs, including
`walletAddress`. That redirects all future revenue to them.

**Detect**

- The provider reports the leak, or the key shows up in a public repo or
  paste.
- Unexpected changes to `apis.wallet_address`, `upstream_url` or `price` for
  that publisher. There is no audit log, so compare with the provider's own
  records.

**Mitigate**

1. Revoke the key, which takes effect immediately:
   ```sql
   update publishers set api_key_hash = 'revoked:' || id where id = '<publisher_id>';
   ```
2. Issue a new key out of band. Generate `mv_` + 64 random hex chars, store
   `sha256(key)` hex in `api_key_hash`, and send the plaintext to the
   provider over a verified channel. There is no rotation endpoint.
3. Check every API for that publisher and restore `wallet_address`,
   `upstream_url`, `price` and `upstream_header_*` to the provider's
   confirmed values.
4. Any revenue already paid to an attacker's wallet is on-chain and cannot
   be reversed.

### B. The provider's upstream secret (the header ZentrixPay injects)

**Mitigate**

1. The provider rotates the key at their own API.
2. They update the gateway with `PATCH /apis/:id` and the new
   `upstreamHeader` value, or the dashboard edit form.

**Follow up**

- Add a key-rotation endpoint for publishers.
- Require a signed wallet confirmation to change `walletAddress`. This is
  already prototyped on `feat/api-gateway-extensions`.
- Keep an audit log of changes to `apis` rows.

---

## Lost `UPSTREAM_SECRET_KEY`

See also [backup and restore](backup-and-restore.md) for what a lost key affects and how to restore the database with its matching key ring.

This key encrypts every provider's upstream secret
([ADR 0004](adr/0004-encrypted-upstream-secrets.md)). Without it, the stored
values cannot be decrypted, and there is no recovery.

**Detect**

- **Key unset** (dropped from the environment during a redeploy): the proxy
  silently stops adding provider headers. Upstreams that require them return
  401/403, so many APIs show 4xx in `api_calls` at once, all with
  `charged = false`. New registrations with a secret return `503`.
- **Key changed** (wrong value deployed): every call to an API with a secret
  throws while decrypting. You will see `unhandled_error` with an
  `Unsupported state or unable to authenticate data` message, and callers
  get `500`. None of these calls are charged.

**Mitigate**

1. **First, look for the old key everywhere:** secret manager history,
   previous deployment configs, CI secrets, the hosting platform's env
   history, and teammates' local `.env` files. Restoring it fixes everything
   immediately.
2. If it is truly gone:
   - Generate a new key: `openssl rand -hex 32`, then deploy it.
   - Clear the unreadable values so the proxy stops returning 500s:
     ```sql
     update apis set upstream_header_value_enc = null where upstream_header_value_enc is not null;
     ```
     Keep `upstream_header_name`. Leaving it set does nothing, because the
     proxy only injects when both name and value exist.
   - Email every affected provider (`select distinct publisher_id from apis
where upstream_header_name is not null`) and ask them to set the
     secret again with `PATCH /apis/:id`. Until they do, their locked-down
     upstreams will reject calls, which are not charged.

**Follow up**

- Store `UPSTREAM_SECRET_KEY` in a secret manager with version history, and
  keep an offline backup held by two people.
- Make the server refuse to start if APIs with stored secrets exist but the
  key is missing or cannot decrypt a canary value.
- Add key ids to the ciphertext format so keys can be rotated gradually.
