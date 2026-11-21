# Backup and restore

This guide covers the Postgres database that holds money-related state: API
call records, credit balances and ledger, and passes. Losing or corrupting it
means losing the record of what was charged and what was settled on Stellar.

## What must be backed up

| Data                                           | Where                                 | Notes                                           |
| ---------------------------------------------- | ------------------------------------- | ----------------------------------------------- |
| Credits, ledger, passes, call records          | Postgres (`DATABASE_URL`)             | Primary target of this guide.                   |
| Encrypted upstream secrets, webhook secrets    | Postgres, encrypted with the key ring | Useless without the matching key (see below).   |
| `UPSTREAM_SECRET_KEYS` / `UPSTREAM_SECRET_KEY` | Secret manager or deploy environment  | **Not** in the database. Back it up separately. |
| Stellar keys (registry/deployer secret)        | Secret manager                        | Not in the database; back up separately.        |

## What is lost if `UPSTREAM_SECRET_KEY` is lost

The key encrypts providers' upstream headers, query secrets and webhook
secrets at rest. The database keeps only ciphertext. If the key is lost:

- Every stored upstream secret becomes unreadable, so proxied calls to those
  upstreams fail until each provider re-enters its secret.
- Webhook signing secrets cannot be recovered; providers must re-register them.
- Nothing in the money records (charges, credits, settlements) is lost, because
  those are not encrypted with this key.

Keep at least two copies of every key in `UPSTREAM_SECRET_KEYS` in a secret
manager that is separate from the database backups. Restoring a database
without its matching keys is not a complete restore.

## Backup

### Managed Postgres (recommended)

Enable automated daily snapshots with point-in-time recovery if the provider
offers it. Set retention to at least **14 days** for daily snapshots and keep
one monthly snapshot for **12 months**.

### Self-hosted Postgres (`pg_dump`)

Run nightly from a host that can reach the database. Use the custom format so
the dump can be restored selectively and compressed:

```sh
export PGPASSWORD="$DB_PASSWORD"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
pg_dump --format=custom --compress=9 --no-owner \
  --file "/backups/zentrixpay-${STAMP}.dump" \
  "postgresql://$DB_USER@$DB_HOST:5432/$DB_NAME"
pg_restore --list "/backups/zentrixpay-${STAMP}.dump" > /dev/null  # verify readable
```

Then copy the file off the host (object storage with versioning or a different
region). Encrypt it at rest; a dump contains ciphertext secrets and PII such as
payer addresses.

### Retention

| Copy                              | Keep for                                                    |
| --------------------------------- | ----------------------------------------------------------- |
| Nightly dumps                     | 14 days                                                     |
| First dump of each month          | 12 months                                                   |
| Key ring (`UPSTREAM_SECRET_KEYS`) | Every key version still referenced by any stored ciphertext |

Delete dumps only after the retention window passes. Never prune the key ring
while any row still uses that key id.

## Restore

Restore into a **new** database first. Never restore over production as a
first step.

```sh
createdb zentrixpay_restore
pg_restore --no-owner --dbname "postgresql://$DB_USER@$DB_HOST/zentrixpay_restore" \
  /backups/zentrixpay-20260101T030000Z.dump
```

Then point a staging server at it:

```sh
DATABASE_URL=postgresql://.../zentrixpay_restore
UPSTREAM_SECRET_KEYS=...   # the key ring that matches this dump
```

Run the server's migrations to confirm the schema is current, then check
that calls and balances look right:

```sql
SELECT count(*) FROM api_calls;
SELECT max(created_at) FROM api_calls;  -- should be close to the dump time
```

## Restore drill

Run this drill every quarter and record the result.

1. Pick the most recent nightly dump.
2. Restore it into `zentrixpay_restore` on a staging host (steps above).
3. Start a staging server against it with the matching key ring.
4. Confirm `GET /health` and `GET /readiness` succeed.
5. Confirm one stored API's upstream secret is still usable (a proxied test
   call succeeds).
6. Drop the scratch database and delete any local copies of the dump.
7. Record the date, dump name, time taken to restore, and any problems in the
   operator runbook's change log.

An operator who has never run these steps should be able to complete the
restore from this page alone. If a step is unclear, fix this page in the same
change.

## Related

- [Operator runbook](operator-runbook.md) — incident procedures, including a
  lost `UPSTREAM_SECRET_KEY`.
- [Server environment variables](server-env.md)
