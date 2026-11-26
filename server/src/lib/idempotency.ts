import { config } from "../config.js";
import { createTtlCache, type TtlCache } from "./ttlCache.js";

// Idempotency support for publish (issue #114). When a client sends an
// `Idempotency-Key`, the first completed publish is remembered so retries with
// the same key return the original response instead of creating a duplicate.
//
// An entry is either "in progress" (a publish is currently running for this
// key) or a stored result. The in-progress marker lets concurrent retries fail
// fast with 409 rather than racing to insert duplicates.

export interface IdempotentResult {
  status: number;
  body: unknown;
}

export type IdempotencyRecord =
  { inProgress: true } | { inProgress: false; result: IdempotentResult };

// Keys are scoped per publisher so one publisher's key can't collide with or
// read another's result.
export function idempotencyCacheKey(publisherId: string, key: string): string {
  return `${publisherId}:${key}`;
}

const defaultStore = createTtlCache<IdempotencyRecord>({
  defaultTtlMs: config.IDEMPOTENCY_TTL_MS,
  cacheName: "idempotency",
});

export function getIdempotencyStore(): TtlCache<IdempotencyRecord> {
  return defaultStore;
}

// ── Paid proxy calls (/api/:id/*) ─────────────────────────────────────────────
//
// A caller retrying a paid call after a network error must not pay twice. The
// first charged response is stored per (API, payer wallet, key) and replayed
// to retries without touching the paywall. Production records expire by TTL;
// cached response bodies are capped to keep database rows bounded.

export interface StoredProxyResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
}

export interface ProxyIdempotencyKey {
  apiId: string;
  payer: string;
  key: string;
}

export type ProxyIdempotencyRecord =
  | { inProgress: true; fingerprint: string }
  | {
      inProgress: false;
      fingerprint: string;
      /** sha256 of the payment header that paid, so an identical resend replays. */
      paymentHash: string;
      /** Null when the response was too large to keep; retries then get 409. */
      response: StoredProxyResponse | null;
      txHash: string | null;
    };

export interface ProxyIdempotencyStore {
  get(key: ProxyIdempotencyKey): Promise<ProxyIdempotencyRecord | undefined>;
  claim(key: ProxyIdempotencyKey, fingerprint: string): Promise<boolean>;
  complete(
    key: ProxyIdempotencyKey,
    record: Extract<ProxyIdempotencyRecord, { inProgress: false }>,
  ): Promise<void>;
  delete(key: ProxyIdempotencyKey): Promise<void>;
}

export function proxyIdempotencyCacheKey(apiId: string, payer: string, key: string): string {
  return JSON.stringify([apiId, payer, key]);
}

class MemoryProxyIdempotencyStore implements ProxyIdempotencyStore {
  private readonly records = new Map<
    string,
    { record: ProxyIdempotencyRecord; expiresAt: number }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  private cacheKey(key: ProxyIdempotencyKey): string {
    return proxyIdempotencyCacheKey(String(key.apiId), key.payer, key.key);
  }

  async get(key: ProxyIdempotencyKey): Promise<ProxyIdempotencyRecord | undefined> {
    const cacheKey = this.cacheKey(key);
    const entry = this.records.get(cacheKey);
    if (!entry) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.records.delete(cacheKey);
      return undefined;
    }
    return entry.record;
  }

  async claim(key: ProxyIdempotencyKey, fingerprint: string): Promise<boolean> {
    const cacheKey = this.cacheKey(key);
    const existing = this.records.get(cacheKey);
    if (existing && this.now() < existing.expiresAt) return false;
    if (existing) this.records.delete(cacheKey);

    for (const [storedKey, entry] of this.records) {
      if (this.now() >= entry.expiresAt) this.records.delete(storedKey);
    }
    if (this.records.size >= config.PROXY_IDEMPOTENCY_MAX_ENTRIES) {
      const oldest = this.records.keys().next().value;
      if (oldest !== undefined) this.records.delete(oldest);
    }

    this.records.set(cacheKey, {
      record: { inProgress: true, fingerprint },
      expiresAt: this.now() + config.PROXY_IDEMPOTENCY_TTL_MS,
    });
    return true;
  }

  async complete(
    key: ProxyIdempotencyKey,
    record: Extract<ProxyIdempotencyRecord, { inProgress: false }>,
  ): Promise<void> {
    const cacheKey = this.cacheKey(key);
    const existing = await this.get(key);
    if (!existing?.inProgress) {
      throw new Error("Cannot complete a proxy idempotency key that is not in progress");
    }
    this.records.set(cacheKey, {
      record,
      expiresAt: this.now() + config.PROXY_IDEMPOTENCY_TTL_MS,
    });
  }

  async delete(key: ProxyIdempotencyKey): Promise<void> {
    this.records.delete(this.cacheKey(key));
  }
}

class PostgresProxyIdempotencyStore implements ProxyIdempotencyStore {
  private async dependencies() {
    const [{ db }, { proxyIdempotency }, { and, eq, lte, lt }] = await Promise.all([
      import("../db/client.js"),
      import("../db/schema.js"),
      import("drizzle-orm"),
    ]);
    return { db, proxyIdempotency, and, eq, lte, lt };
  }

  async get(key: ProxyIdempotencyKey): Promise<ProxyIdempotencyRecord | undefined> {
    const { db, proxyIdempotency, and, eq } = await this.dependencies();
    const [row] = await db
      .select()
      .from(proxyIdempotency)
      .where(
        and(
          eq(proxyIdempotency.apiId, key.apiId),
          eq(proxyIdempotency.payer, key.payer),
          eq(proxyIdempotency.key, key.key),
        ),
      )
      .limit(1);

    if (!row) return undefined;
    if (row.expiresAt.getTime() <= Date.now()) {
      await this.delete(key);
      return undefined;
    }
    if (row.state === "in_progress") {
      return { inProgress: true, fingerprint: row.fingerprint };
    }

    return {
      inProgress: false,
      fingerprint: row.fingerprint,
      paymentHash: row.paymentHash ?? "",
      response: row.response
        ? {
            status: row.response.status,
            headers: row.response.headers,
            body: Buffer.from(row.response.body, "base64"),
          }
        : null,
      txHash: row.txHash,
    };
  }

  async claim(key: ProxyIdempotencyKey, fingerprint: string): Promise<boolean> {
    const { db, proxyIdempotency, and, eq, lte } = await this.dependencies();
    const now = new Date();
    await db.delete(proxyIdempotency).where(lte(proxyIdempotency.expiresAt, now));
    const inserted = await db
      .insert(proxyIdempotency)
      .values({
        ...key,
        fingerprint,
        state: "in_progress",
        expiresAt: new Date(now.getTime() + config.PROXY_IDEMPOTENCY_TTL_MS),
      })
      .onConflictDoNothing({
        target: [proxyIdempotency.apiId, proxyIdempotency.payer, proxyIdempotency.key],
      })
      .returning({ apiId: proxyIdempotency.apiId });

    if (inserted.length > 0) return true;

    const [expired] = await db
      .delete(proxyIdempotency)
      .where(
        and(
          eq(proxyIdempotency.apiId, key.apiId),
          eq(proxyIdempotency.payer, key.payer),
          eq(proxyIdempotency.key, key.key),
          lte(proxyIdempotency.expiresAt, now),
        ),
      )
      .returning({ apiId: proxyIdempotency.apiId });
    if (!expired) return false;

    const retried = await db
      .insert(proxyIdempotency)
      .values({
        ...key,
        fingerprint,
        state: "in_progress",
        expiresAt: new Date(now.getTime() + config.PROXY_IDEMPOTENCY_TTL_MS),
      })
      .onConflictDoNothing({
        target: [proxyIdempotency.apiId, proxyIdempotency.payer, proxyIdempotency.key],
      })
      .returning({ apiId: proxyIdempotency.apiId });
    return retried.length > 0;
  }

  async complete(
    key: ProxyIdempotencyKey,
    record: Extract<ProxyIdempotencyRecord, { inProgress: false }>,
  ): Promise<void> {
    const { db, proxyIdempotency, and, eq } = await this.dependencies();
    const updated = await db
      .update(proxyIdempotency)
      .set({
        fingerprint: record.fingerprint,
        state: "completed",
        paymentHash: record.paymentHash,
        response: record.response
          ? {
              status: record.response.status,
              headers: record.response.headers,
              body: record.response.body.toString("base64"),
            }
          : null,
        txHash: record.txHash,
        expiresAt: new Date(Date.now() + config.PROXY_IDEMPOTENCY_TTL_MS),
      })
      .where(
        and(
          eq(proxyIdempotency.apiId, key.apiId),
          eq(proxyIdempotency.payer, key.payer),
          eq(proxyIdempotency.key, key.key),
          eq(proxyIdempotency.state, "in_progress"),
        ),
      )
      .returning({ apiId: proxyIdempotency.apiId });
    if (updated.length === 0) {
      throw new Error("Cannot complete a proxy idempotency key that is not in progress");
    }
  }

  async delete(key: ProxyIdempotencyKey): Promise<void> {
    const { db, proxyIdempotency, and, eq } = await this.dependencies();
    await db
      .delete(proxyIdempotency)
      .where(
        and(
          eq(proxyIdempotency.apiId, key.apiId),
          eq(proxyIdempotency.payer, key.payer),
          eq(proxyIdempotency.key, key.key),
          eq(proxyIdempotency.state, "in_progress"),
        ),
      );
  }
}

let proxyStore: ProxyIdempotencyStore | undefined;

export function createPostgresProxyIdempotencyStore(): ProxyIdempotencyStore {
  return new PostgresProxyIdempotencyStore();
}

export function getProxyIdempotencyStore(): ProxyIdempotencyStore {
  if (!proxyStore) {
    proxyStore =
      config.NODE_ENV === "test"
        ? new MemoryProxyIdempotencyStore()
        : createPostgresProxyIdempotencyStore();
  }
  return proxyStore;
}
