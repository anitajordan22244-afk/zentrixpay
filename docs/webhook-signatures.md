# Verifying ZentrixPay webhook signatures

Every webhook delivery is signed so your endpoint can prove it came from ZentrixPay and was not altered or replayed.

## Headers

| Header                   | Meaning                                                             |
| ------------------------ | ------------------------------------------------------------------- |
| `X-ZentrixPay-Event`     | Event type, e.g. `api.call.charged`                                 |
| `X-ZentrixPay-Delivery`  | Event id (`evt_…`). Stable across retries, so use it to deduplicate |
| `X-ZentrixPay-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256>`                             |

## The scheme

`v1 = HMAC-SHA256(secret, "<t>.<raw request body>")`, hex encoded.

Verify it like this:

1. Read the **raw** body exactly as received. Do not re-serialize parsed JSON.
2. Parse `t` and every `v1` value from the signature header.
3. Reject the request if `|now − t| > 300` seconds (the recommended **5-minute tolerance**). This blocks replays.
4. Recompute the HMAC with your webhook secret and compare it to each `v1` value using a **constant-time** comparison.
5. Accept if any `v1` matches. More than one `v1` can appear during secret rotation.

Non-2xx responses and network errors are retried with exponential backoff, so make your handler idempotent on `X-ZentrixPay-Delivery`.

## Node.js

```js
import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 300;

export function verifyZentrixPayWebhook(
  secret,
  header,
  rawBody,
  now = Math.floor(Date.now() / 1000),
) {
  if (!header) return false;
  let t;
  const v1 = [];
  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t" && /^\d+$/.test(value ?? "")) t = Number(value);
    if (key === "v1" && value) v1.push(value);
  }
  if (t === undefined || v1.length === 0) return false;
  if (Math.abs(now - t) > TOLERANCE_SECONDS) return false;

  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  return v1.some((hex) => {
    const given = Buffer.from(hex, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
```

## Python

```python
import hashlib
import hmac
import time

TOLERANCE_SECONDS = 300


def verify_zentrixpay_webhook(secret: str, header: str, raw_body: bytes, now=None) -> bool:
    if not header:
        return False
    t = None
    v1 = []
    for part in header.split(","):
        key, _, value = part.strip().partition("=")
        if key == "t" and value.isdigit():
            t = int(value)
        elif key == "v1" and value:
            v1.append(value)
    if t is None or not v1:
        return False
    now = int(time.time()) if now is None else now
    if abs(now - t) > TOLERANCE_SECONDS:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, given) for given in v1)
```

## Go

```go
package zentrixpay

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"
)

const toleranceSeconds = 300

func VerifyWebhook(secret, header string, rawBody []byte, now time.Time) bool {
	var t int64 = -1
	var v1 []string
	for _, part := range strings.Split(header, ",") {
		key, value, _ := strings.Cut(strings.TrimSpace(part), "=")
		switch key {
		case "t":
			if parsed, err := strconv.ParseInt(value, 10, 64); err == nil {
				t = parsed
			}
		case "v1":
			if value != "" {
				v1 = append(v1, value)
			}
		}
	}
	if t < 0 || len(v1) == 0 {
		return false
	}
	diff := now.Unix() - t
	if diff < -toleranceSeconds || diff > toleranceSeconds {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "%d.", t)
	mac.Write(rawBody)
	expected := mac.Sum(nil)
	for _, hexSig := range v1 {
		given, err := hex.DecodeString(hexSig)
		if err == nil && hmac.Equal(given, expected) {
			return true
		}
	}
	return false
}
```

## Test vector

Use this to check your implementation. The values are the ones used in `server/src/services/webhookService.test.ts`. They are not real secrets.

- secret: `whsec_test_value`
- `t`: `1700000000`
- body: `{"id":"evt_1","type":"api.call.charged","data":{"apiId":1}}`

Compute `HMAC-SHA256(secret, "1700000000." + body)`; the hex result is the `v1` value. The Node, Python and Go examples above were checked against this vector.

## Rotating the secret

Owners rotate a signing secret with `POST /apis/:id/webhook/secret/rotate`. The response carries the new secret once. For 24 hours after a rotation, deliveries carry two `v1=` values, one per secret, so either secret verifies. Switch your receiver to the new secret, then call `POST /apis/:id/webhook/secret/expire` to end the grace period early. After it ends, only the new secret signs.

## Delivery log, test ping and redelivery

Owners can inspect and retry deliveries. All three endpoints are owner-only; another publisher gets `404`.

- `GET /apis/:id/webhooks/deliveries` lists the last 100 deliveries with status (`pending`, `delivered`, `failed`), attempts and last error. The log is kept in memory, so it resets when the server restarts.
- `POST /apis/:id/webhooks/test` sends one signed `webhook.test` ping, with no retries, and returns its result.
- `POST /apis/:id/webhooks/deliveries/:deliveryId/redeliver` re-sends a logged event with the same event id and body and a fresh signature. It answers `202` and the attempt runs in the background.
