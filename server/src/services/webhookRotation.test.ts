import { beforeEach, describe, expect, it, vi } from "vitest";

const updates: Array<{ set: Record<string, unknown> }> = [];

vi.mock("../config.js", () => ({
  config: { UPSTREAM_SECRET_KEY: "", WEBHOOK_RETRY_BASE_MS: 1000, WEBHOOK_TIMEOUT_MS: 5000 },
  upstreamKeyRing: [{ id: "k1", key: "00" }],
}));
// Plaintext stands in for ciphertext: "enc:<value>" round-trips to <value>.
vi.mock("../utils/secretBox.js", () => ({
  encryptSecret: (plain: string) => `enc:${plain}`,
  decryptSecret: (enc: string) => {
    if (!enc.startsWith("enc:")) throw new Error("bad ciphertext");
    return enc.slice(4);
  },
}));
vi.mock("../db/client.js", () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push({ set: values });
        return { where: async () => undefined };
      },
    }),
  },
}));

import {
  activeWebhookSecrets,
  rotateWebhookSecret,
  expireWebhookPreviousSecret,
  verifyWebhookSignature,
  webhookSignatureHeaderForSecrets,
  WEBHOOK_ROTATION_GRACE_MS,
} from "./webhookService.js";
import type { ApiRow } from "./apiService.js";

const NOW = 1_800_000_000_000;
const BODY = JSON.stringify({ id: "evt_9", type: "api.call.charged" });

function api(overrides: Partial<ApiRow> = {}): ApiRow {
  return {
    id: 3,
    webhookUrl: "https://provider.test/hook",
    webhookSecretEnc: "enc:new-secret",
    webhookPreviousSecretEnc: "enc:old-secret",
    webhookPreviousSecretExpiresAt: new Date(NOW + 60_000),
    ...overrides,
  } as ApiRow;
}

beforeEach(() => {
  updates.length = 0;
});

describe("webhook secret rotation (#211)", () => {
  it("accepts either secret during the grace period", () => {
    const secrets = activeWebhookSecrets(api(), NOW);
    expect(secrets).toEqual(["new-secret", "old-secret"]);

    const header = webhookSignatureHeaderForSecrets(secrets, NOW / 1000, BODY);
    expect(header.match(/v1=/g)).toHaveLength(2);
    expect(verifyWebhookSignature("old-secret", header, BODY, NOW / 1000)).toEqual({ ok: true });
    expect(verifyWebhookSignature("new-secret", header, BODY, NOW / 1000)).toEqual({ ok: true });
  });

  it("only the new secret verifies after the grace period expires", () => {
    const expired = api({ webhookPreviousSecretExpiresAt: new Date(NOW - 1) });
    const secrets = activeWebhookSecrets(expired, NOW);
    expect(secrets).toEqual(["new-secret"]);

    const header = webhookSignatureHeaderForSecrets(secrets, NOW / 1000, BODY);
    expect(verifyWebhookSignature("old-secret", header, BODY, NOW / 1000)).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(verifyWebhookSignature("new-secret", header, BODY, NOW / 1000)).toEqual({ ok: true });
  });

  it("signs with the current secret alone when no rotation is pending", () => {
    expect(
      activeWebhookSecrets(
        api({ webhookPreviousSecretEnc: null, webhookPreviousSecretExpiresAt: null }),
        NOW,
      ),
    ).toEqual(["new-secret"]);
  });

  it("rotate moves the current secret to previous with a grace period and returns the new one", async () => {
    const secret = await rotateWebhookSecret(
      api({ webhookSecretEnc: "enc:old-secret", webhookPreviousSecretEnc: null }),
      NOW,
    );
    expect(secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(updates[0].set.webhookSecretEnc).toBe(`enc:${secret}`);
    expect(updates[0].set.webhookPreviousSecretEnc).toBe("enc:old-secret");
    expect(updates[0].set.webhookPreviousSecretExpiresAt).toEqual(
      new Date(NOW + WEBHOOK_ROTATION_GRACE_MS),
    );
  });

  it("expire clears the previous secret", async () => {
    await expireWebhookPreviousSecret(api());
    expect(updates[0].set).toEqual({
      webhookPreviousSecretEnc: null,
      webhookPreviousSecretExpiresAt: null,
    });
  });
});
