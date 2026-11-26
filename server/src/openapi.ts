/**
 * OpenAPI 3.0 document for the pay-per-call gateway, served at /openapi.json
 * and rendered by Swagger UI at /docs.
 *
 * Covers the public API catalog, publisher registration and API management,
 * usage statistics, payer receipts and the x402-metered proxy. Keep it in step
 * with routes/apis.ts and routes/publishers.ts — openapi.test.ts checks that
 * the key routes are present.
 */

type Json = Record<string, unknown>;

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers?: Array<{ url: string; description?: string }>;
  tags?: Array<{ name: string; description?: string }>;
  components: {
    securitySchemes: Record<string, Json>;
    schemas: Record<string, Json>;
    parameters: Record<string, Json>;
    headers: Record<string, Json>;
    responses: Record<string, Json>;
  };
  paths: Record<string, Record<string, Json | Json[]>>;
}

const ref = (kind: string, name: string) => ({ $ref: `#/components/${kind}/${name}` });
const schemaRef = (name: string) => ref("schemas", name);
const responseRef = (name: string) => ref("responses", name);
const paramRef = (name: string) => ref("parameters", name);
const headerRef = (name: string) => ref("headers", name);

const json = (schema: Json) => ({ "application/json": { schema } });

const walletTimestampHeader = {
  name: "X-Wallet-Timestamp",
  in: "header",
  required: true,
  description: "Unix timestamp (seconds) included in the signed wallet-auth message.",
  schema: { type: "string", pattern: "^\\d+$" },
};

const walletSignatureRefused = {
  description: "Missing, stale or invalid wallet signature.",
  content: json(ref("schemas", "Error")),
};

const usdcAmount = {
  type: "string",
  pattern: "^\\d+(\\.\\d{1,7})?$",
  description: "USDC amount as a decimal string (up to 7 decimal places).",
  example: "0.01",
};

const stellarAddress = {
  type: "string",
  pattern: "^G[A-Z2-7]{55}$",
  description: "Stellar public key (G...).",
  example: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
};

const PROXY_METHODS = ["get", "post", "put", "patch", "delete"] as const;

const rateLimitHeaders = {
  "RateLimit-Limit": headerRef("RateLimitLimit"),
  "RateLimit-Remaining": headerRef("RateLimitRemaining"),
  "RateLimit-Reset": headerRef("RateLimitReset"),
};

/** One proxied HTTP method on /api/{id} or /api/{id}/{path}. */
function proxyOperation(method: (typeof PROXY_METHODS)[number], withPath: boolean): Json {
  const upper = method.toUpperCase();
  const hasBody = method !== "get" && method !== "delete";
  return {
    tags: ["Proxy"],
    summary: `Paid ${upper} call${withPath ? " to an upstream path" : ""}`,
    description:
      `Forwards one ${upper} request to the provider's upstream API, metered with x402. ` +
      "Without a valid payment the gateway answers 402 with a PAYMENT-REQUIRED header " +
      "describing what to pay (price in USDC on Stellar, payee wallet, network). Retry the " +
      "same request with the signed payment in the PAYMENT-SIGNATURE (or legacy X-PAYMENT) " +
      "header; on success the upstream response is returned with a PAYMENT-RESPONSE header " +
      "carrying the settlement receipt. Callers are only charged when the final status is " +
      "below 400, and are never charged for upstream failures (502/504). An active access " +
      "pass or the provider's daily free-call allowance skips the payment step. The method " +
      "must be one of the API's allowedMethods, otherwise 405 is returned.",
    operationId: `proxy${upper[0]}${upper.slice(1).toLowerCase()}${withPath ? "Path" : ""}`,
    security: [{}, { X402Payment: [] }],
    parameters: [paramRef("IdempotencyKey")],
    ...(hasBody
      ? {
          requestBody: {
            required: false,
            description: "Forwarded to the upstream unchanged (any content type).",
            content: { "*/*": { schema: { type: "string", format: "binary" } } },
          },
        }
      : {}),
    responses: {
      "200": {
        description:
          "The upstream response (status, headers and body are passed through; any status " +
          "below 400 is a charged call).",
        headers: {
          "PAYMENT-RESPONSE": headerRef("PaymentResponse"),
          "Idempotent-Replayed": headerRef("IdempotentReplayed"),
        },
        content: { "*/*": { schema: { type: "string", format: "binary" } } },
      },
      "400": responseRef("BadRequest"),
      "402": responseRef("PaymentRequired"),
      "404": responseRef("NotFound"),
      "405": responseRef("MethodNotAllowed"),
      "409": responseRef("IdempotencyConflict"),
      "422": responseRef("IdempotencyMismatch"),
      "429": responseRef("TooManyRequests"),
      "502": responseRef("UpstreamFailed"),
      "504": responseRef("UpstreamTimeout"),
    },
  };
}

function proxyPathItem(withPath: boolean) {
  const item: Record<string, Json | Json[]> = {
    parameters: withPath ? [paramRef("ApiId"), paramRef("UpstreamPath")] : [paramRef("ApiId")],
  };
  for (const m of PROXY_METHODS) item[m] = proxyOperation(m, withPath);
  return item;
}

export const openApiSpec: OpenApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "ZentrixPay Gateway API",
    version: "1.0.0",
    description:
      "ZentrixPay is a pay-per-call API gateway. Providers register as publishers, add " +
      "their HTTP APIs with a per-call price in USDC, and get a proxy URL. Callers discover " +
      "APIs in the public catalog and pay for each call through the x402 protocol, settled " +
      "on Stellar.\n\n" +
      "**Authentication.** Publisher routes take the `x-api-key` header returned once by " +
      "`POST /publishers`. When the server enables request signatures, mutating publisher " +
      "routes also need `X-Timestamp` and `X-Signature` (HMAC-SHA256).\n\n" +
      "**Pagination.** List endpoints use `limit` / `offset` query parameters.\n\n" +
      "**Errors.** Errors are JSON objects with an `error` field. Validation errors (400) " +
      "carry the field-by-field validation result in `error`.\n\n" +
      "**Pricing.** The order in which allowlists, passes, free quota, credits and price " +
      "rules are applied to a paid call is documented in `docs/paid-call-pricing.md`.",
  },
  servers: [{ url: "/", description: "Current server" }],
  tags: [
    { name: "Catalog", description: "Discover listed APIs (public)." },
    { name: "Publishers", description: "Publisher registration." },
    { name: "API management", description: "Create and manage your APIs (publisher)." },
    { name: "Statistics", description: "Usage, revenue and payer receipts." },
    { name: "Proxy", description: "x402-metered calls to a provider's API." },
  ],
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: "apiKey",
        in: "header",
        name: "x-api-key",
        description: "Publisher API key, shown once by POST /publishers.",
      },
      WalletSignature: {
        type: "apiKey",
        in: "header",
        name: "X-Wallet-Signature",
        description:
          "Base64 Ed25519 signature, by the wallet in the path, of the UTF-8 message " +
          '"zentrixpay:wallet-auth\\n<METHOD>\\n<path>\\n<address>\\n<timestamp>". Send the same unix ' +
          "timestamp (seconds) in X-Wallet-Timestamp. Raw and SEP-53 (Freighter) signatures " +
          "are accepted.",
      },
      X402Payment: {
        type: "apiKey",
        in: "header",
        name: "PAYMENT-SIGNATURE",
        description:
          "Base64 x402 payment payload answering a 402 challenge. The legacy X-PAYMENT " +
          "header is also accepted.",
      },
    },
    parameters: {
      ApiId: {
        name: "id",
        in: "path",
        required: true,
        description: "API identifier.",
        schema: { type: "string" },
      },
      UpstreamPath: {
        name: "path",
        in: "path",
        required: true,
        description:
          "Path appended to the API's upstream URL (may contain several segments). The query " +
          "string is forwarded too. `.` / `..` segments are rejected.",
        schema: { type: "string" },
      },
      Limit: {
        name: "limit",
        in: "query",
        required: false,
        description: "Page size.",
        schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
      Offset: {
        name: "offset",
        in: "query",
        required: false,
        description: "Number of items to skip.",
        schema: { type: "integer", minimum: 0, default: 0 },
      },
      IdempotencyKey: {
        name: "Idempotency-Key",
        in: "header",
        required: false,
        description:
          "Optional key (max 255 chars), scoped per API and payer wallet. Retrying a charged " +
          "call with the same key and payment replays the stored response instead of calling " +
          "the upstream again.",
        schema: { type: "string", maxLength: 255 },
      },
      RequestTimestamp: {
        name: "X-Timestamp",
        in: "header",
        required: false,
        description: "Unix time in ms. Required when request signatures are enabled.",
        schema: { type: "string" },
      },
      RequestSignature: {
        name: "X-Signature",
        in: "header",
        required: false,
        description: "HMAC-SHA256 request signature. Required when request signatures are enabled.",
        schema: { type: "string" },
      },
    },
    headers: {
      PaymentRequired: {
        description: "Base64-encoded x402 payment requirements (price, payee, network, asset).",
        schema: { type: "string" },
      },
      PaymentResponse: {
        description: "Base64-encoded x402 settlement receipt, including the transaction hash.",
        schema: { type: "string" },
      },
      IdempotentReplayed: {
        description: "`true` when the response was replayed for a repeated Idempotency-Key.",
        schema: { type: "string", enum: ["true"] },
      },
      RateLimitLimit: { description: "Requests allowed per window.", schema: { type: "integer" } },
      RateLimitRemaining: {
        description: "Requests left in the current window.",
        schema: { type: "integer" },
      },
      RateLimitReset: {
        description: "Unix time (seconds) when the window frees up.",
        schema: { type: "integer" },
      },
      RetryAfter: { description: "Seconds to wait before retrying.", schema: { type: "integer" } },
    },
    schemas: {
      Error: {
        type: "object",
        required: ["error"],
        properties: {
          error: {
            description: "Error message, or the validation result for 400 responses.",
            oneOf: [{ type: "string" }, { type: "object", additionalProperties: true }],
          },
        },
      },
      RateLimitError: {
        type: "object",
        required: ["error", "code", "retryAfterSeconds"],
        properties: {
          error: { type: "string", example: "Too many requests" },
          code: { type: "string", enum: ["RATE_LIMITED"] },
          retryAfterSeconds: { type: "integer" },
        },
      },
      UpstreamError: {
        type: "object",
        description:
          "Returned when the upstream API could not be called. `code` is the stable, machine-readable error code; `reason` is the legacy kind (kept for compatibility).",
        required: ["error", "reason", "code"],
        properties: {
          error: { type: "string", enum: ["upstream_failed"] },
          reason: { type: "string", enum: ["blocked", "network", "too_large", "timeout"] },
          code: {
            type: "string",
            enum: [
              "upstream_blocked",
              "upstream_network",
              "upstream_too_large",
              "upstream_timeout",
            ],
          },
        },
      },
      HttpMethod: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
      PublicApi: {
        type: "object",
        description: "What anyone can see about a listed API.",
        required: [
          "id",
          "name",
          "price",
          "currency",
          "walletAddress",
          "allowedMethods",
          "tags",
          "proxyUrl",
          "onchain",
          "createdAt",
        ],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          description: { type: "string", nullable: true },
          price: { ...usdcAmount, description: "Price per call in USDC." },
          currency: { type: "string", enum: ["USDC"] },
          walletAddress: { ...stellarAddress, description: "Payee wallet." },
          allowedMethods: { type: "array", items: schemaRef("HttpMethod") },
          tags: { type: "array", items: { type: "string" } },
          passPrice: {
            ...usdcAmount,
            nullable: true,
            description: "Price of an access pass, or null if passes are not offered.",
          },
          passDurationMs: {
            type: "integer",
            minimum: 3600000,
            maximum: 2592000000,
            description:
              "How long an access pass lasts once bought, in milliseconds (1 hour to 30 days).",
          },
          freeCallsPerDay: {
            type: "integer",
            description: "Free calls per payer per UTC day before payment is required.",
          },
          proxyUrl: {
            type: "string",
            format: "uri",
            description: "Call this URL (plus any upstream path) to use the API.",
          },
          openapiUrl: {
            type: "string",
            format: "uri",
            nullable: true,
            description: "The API's own OpenAPI document, if the provider uploaded one.",
          },
          onchain: {
            type: "object",
            properties: {
              registered: { type: "boolean" },
              contractId: { type: "string", nullable: true },
              txHash: { type: "string", nullable: true },
            },
          },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      OwnerApi: {
        description:
          "What the owning publisher sees. Includes the upstream URL but never secret values.",
        allOf: [
          schemaRef("PublicApi"),
          {
            type: "object",
            properties: {
              upstreamUrl: { type: "string", format: "uri" },
              upstreamHeaderName: { type: "string", nullable: true },
              hasUpstreamSecret: { type: "boolean" },
              upstreamQueryParamName: { type: "string", nullable: true },
              hasUpstreamQuerySecret: { type: "boolean" },
              timeoutMs: { type: "integer", nullable: true },
              payerAllowlist: {
                type: "array",
                nullable: true,
                items: stellarAddress,
              },
              payerDenylist: { type: "array", items: stellarAddress },
              listed: { type: "boolean" },
              onchainStatus: { type: "string" },
              ownershipVerified: { type: "boolean" },
              ownershipVerification: {
                type: "object",
                description: "Serve expectedContent at url to prove you own the upstream.",
                properties: {
                  url: { type: "string", format: "uri" },
                  expectedContent: { type: "string" },
                },
              },
            },
          },
        ],
      },
      CreatedApi: {
        allOf: [
          schemaRef("OwnerApi"),
          {
            type: "object",
            properties: {
              nextStep: { type: "string", description: "What to do to get the API listed." },
            },
          },
        ],
      },
      UpstreamHeader: {
        type: "object",
        required: ["name", "value"],
        additionalProperties: false,
        description: "Secret header added to every forwarded call. Stored encrypted.",
        properties: {
          name: { type: "string", example: "x-api-key" },
          value: { type: "string", maxLength: 4096 },
        },
      },
      UpstreamQueryParam: {
        type: "object",
        required: ["name", "value"],
        additionalProperties: false,
        description: "Secret query parameter added to every forwarded call. Stored encrypted.",
        properties: {
          name: { type: "string", maxLength: 128 },
          value: { type: "string", maxLength: 4096 },
        },
      },
      Webhook: {
        type: "object",
        required: ["url", "secret"],
        additionalProperties: false,
        description: "Receives an HMAC-SHA256 signed event for every charged call.",
        properties: {
          url: { type: "string", format: "uri" },
          secret: { type: "string", minLength: 16, maxLength: 256 },
        },
      },
      CreateApiRequest: {
        type: "object",
        additionalProperties: false,
        required: ["name", "upstreamUrl", "price"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 120 },
          description: { type: "string", maxLength: 2000 },
          upstreamUrl: {
            type: "string",
            format: "uri",
            description: "Your API's base URL. Must be public; callers never see it.",
          },
          price: usdcAmount,
          walletAddress: {
            ...stellarAddress,
            description: "Payee wallet. Defaults to the publisher's wallet.",
          },
          allowedMethods: {
            type: "array",
            minItems: 1,
            items: schemaRef("HttpMethod"),
            default: ["GET"],
          },
          upstreamHeader: schemaRef("UpstreamHeader"),
          upstreamQueryParam: schemaRef("UpstreamQueryParam"),
          openapiSpec: {
            description: "Your API's OpenAPI 3 document (JSON/YAML text or a JSON object).",
            oneOf: [{ type: "string" }, { type: "object", additionalProperties: true }],
          },
          timeoutMs: { type: "integer", minimum: 1000 },
          maxResponseBytes: { type: "integer", minimum: 1024 },
          webhook: schemaRef("Webhook"),
          healthPath: {
            type: "string",
            maxLength: 512,
            pattern: "^/[^\\s#]*$",
            description: "Path pinged to check the upstream is up.",
          },
          tags: { type: "array", maxItems: 10, items: { type: "string", maxLength: 32 } },
          payerAllowlist: {
            type: "array",
            maxItems: 500,
            items: stellarAddress,
            description: "Only these wallets may call the API. Omit to allow everyone.",
          },
          payerDenylist: { type: "array", maxItems: 500, items: stellarAddress },
        },
      },
      UpdateApiRequest: {
        type: "object",
        additionalProperties: false,
        description:
          "Every field is optional; send null to clear a nullable setting. Changing " +
          "walletAddress also needs X-Payee-Timestamp and X-Payee-Signature from the current " +
          "payee wallet.",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 120 },
          description: { type: "string", maxLength: 2000, nullable: true },
          upstreamUrl: { type: "string", format: "uri" },
          price: usdcAmount,
          walletAddress: stellarAddress,
          allowedMethods: { type: "array", minItems: 1, items: schemaRef("HttpMethod") },
          upstreamHeader: { allOf: [schemaRef("UpstreamHeader")], nullable: true },
          upstreamQueryParam: { allOf: [schemaRef("UpstreamQueryParam")], nullable: true },
          openapiSpec: {
            nullable: true,
            oneOf: [{ type: "string" }, { type: "object", additionalProperties: true }],
          },
          timeoutMs: { type: "integer", minimum: 1000, nullable: true },
          maxResponseBytes: { type: "integer", minimum: 1024, nullable: true },
          webhook: { allOf: [schemaRef("Webhook")], nullable: true },
          healthPath: { type: "string", maxLength: 512, nullable: true },
          tags: { type: "array", maxItems: 10, items: { type: "string", maxLength: 32 } },
          payerAllowlist: { type: "array", nullable: true, maxItems: 500, items: stellarAddress },
          payerDenylist: { type: "array", maxItems: 500, items: stellarAddress },
          listed: {
            type: "boolean",
            description: "List or unlist the API (listing needs verified ownership).",
          },
        },
      },
      ArchivedApi: {
        type: "object",
        required: ["id", "archived", "archivedAt"],
        properties: {
          id: { type: "string" },
          archived: { type: "boolean", enum: [true] },
          archivedAt: { type: "string", format: "date-time" },
        },
      },
      ApiCall: {
        type: "object",
        description: "One proxied call.",
        properties: {
          id: { type: "string" },
          apiId: { type: "string" },
          payerAddress: { type: "string" },
          amount: usdcAmount,
          charged: { type: "boolean" },
          method: schemaRef("HttpMethod"),
          path: { type: "string" },
          responseStatus: { type: "integer" },
          durationMs: { type: "integer" },
          txHash: { type: "string", nullable: true, description: "Settlement transaction." },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      ApiStats: {
        type: "object",
        required: ["apiId", "calls", "chargedCalls", "revenue", "currency", "recentCalls"],
        properties: {
          apiId: { type: "string" },
          archivedAt: { type: "string", format: "date-time", nullable: true },
          calls: { type: "integer", description: "All recorded calls." },
          chargedCalls: { type: "integer" },
          revenue: { ...usdcAmount, description: "Gross revenue from charged calls." },
          uniquePayers: { type: "integer" },
          avgDurationMs: { type: "integer" },
          refundedCalls: { type: "integer" },
          refunded: usdcAmount,
          netRevenue: { ...usdcAmount, description: "Revenue minus refunds." },
          currency: { type: "string", enum: ["USDC"] },
          recentCalls: {
            type: "array",
            maxItems: 50,
            description: "The 50 most recent calls, newest first.",
            items: schemaRef("ApiCall"),
          },
        },
      },
      ApiTimeSeries: {
        type: "object",
        required: ["apiId", "days", "series"],
        properties: {
          apiId: { type: "string" },
          days: { type: "integer", enum: [7, 30, 90] },
          series: {
            type: "array",
            description: "One point per UTC day, oldest first; days without calls are zero.",
            items: {
              type: "object",
              required: ["date", "calls", "revenue"],
              properties: {
                date: { type: "string", format: "date" },
                calls: { type: "integer" },
                revenue: usdcAmount,
              },
            },
          },
        },
      },
      PayerCalls: {
        type: "object",
        required: ["payer", "calls", "limit", "offset", "nextOffset"],
        properties: {
          payer: stellarAddress,
          calls: { type: "array", items: schemaRef("ApiCall") },
          limit: { type: "integer" },
          offset: { type: "integer" },
          nextOffset: {
            type: "integer",
            nullable: true,
            description: "Offset of the next page, or null on the last page.",
          },
        },
      },
      PayerEntitlements: {
        type: "object",
        required: ["payer", "passes", "credits"],
        properties: {
          payer: stellarAddress,
          passes: {
            type: "array",
            description: "Passes active now, soonest expiry first.",
            items: {
              type: "object",
              required: ["passId", "apiId", "apiName", "activeFrom", "expiresAt"],
              properties: {
                passId: { type: "string" },
                apiId: { type: "string" },
                apiName: { type: "string" },
                activeFrom: { type: "string", format: "date-time" },
                expiresAt: { type: "string", format: "date-time" },
              },
            },
          },
          credits: {
            type: "array",
            description: "Non-zero prepaid call credit balances, per API.",
            items: {
              type: "object",
              required: ["apiId", "apiName", "balance", "updatedAt"],
              properties: {
                apiId: { type: "string" },
                apiName: { type: "string" },
                balance: { type: "integer", minimum: 1 },
                updatedAt: { type: "string", format: "date-time" },
              },
            },
          },
        },
      },
      AccessPass: {
        type: "object",
        required: ["passId", "expiresAt", "message"],
        properties: {
          passId: { type: "string" },
          expiresAt: { type: "string", format: "date-time" },
          txHash: {
            type: "string",
            description: "Settlement transaction of the pass payment (on new passes).",
          },
          message: { type: "string", enum: ["Pass activated", "Pass already active"] },
        },
      },
      CreatePublisherRequest: {
        type: "object",
        additionalProperties: false,
        required: ["name", "email", "walletAddress"],
        properties: {
          name: { type: "string" },
          email: { type: "string", format: "email" },
          walletAddress: { ...stellarAddress, description: "Default payout wallet." },
        },
      },
      RegisteredPublisher: {
        type: "object",
        required: ["id", "name", "email", "walletAddress", "apiKey", "createdAt"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          email: { type: "string", format: "email" },
          walletAddress: stellarAddress,
          apiKey: {
            type: "string",
            description: "Publisher API key. Shown only once — store it securely.",
          },
          createdAt: { type: "string", format: "date-time" },
        },
      },
    },
    responses: {
      BadRequest: {
        description: "The request failed validation.",
        content: json(schemaRef("Error")),
      },
      Unauthorized: {
        description: "Missing or invalid x-api-key (or request signature).",
        content: json(schemaRef("Error")),
      },
      Forbidden: {
        description: "Payee signature missing or invalid when changing walletAddress.",
        content: json(schemaRef("Error")),
      },
      NotFound: {
        description: "Not found, not listed, or not owned by the caller.",
        content: json(schemaRef("Error")),
      },
      Conflict: { description: "Conflict.", content: json(schemaRef("Error")) },
      TooManyRequests: {
        description: "Rate limit exceeded for this client IP or wallet.",
        headers: { "Retry-After": headerRef("RetryAfter"), ...rateLimitHeaders },
        content: json(schemaRef("RateLimitError")),
      },
      PaymentRequired: {
        description:
          "x402 challenge: no (valid) payment was attached. Pay the amount described in the " +
          "PAYMENT-REQUIRED header and retry with PAYMENT-SIGNATURE.",
        headers: { "PAYMENT-REQUIRED": headerRef("PaymentRequired") },
        content: json({ type: "object", additionalProperties: true }),
      },
      MethodNotAllowed: {
        description: "The HTTP method is not in the API's allowedMethods.",
        headers: {
          Allow: { description: "Allowed methods.", schema: { type: "string" } },
        },
        content: json(schemaRef("Error")),
      },
      IdempotencyConflict: {
        description:
          "The Idempotency-Key is in use by a call in progress, or was used with a different " +
          "payment.",
        content: json(schemaRef("Error")),
      },
      IdempotencyMismatch: {
        description: "The Idempotency-Key was already used for a different request.",
        content: json(schemaRef("Error")),
      },
      UpstreamFailed: {
        description:
          "The upstream could not be reached, was blocked, or returned too large a body. Not " +
          "charged.",
        content: json(schemaRef("UpstreamError")),
      },
      UpstreamTimeout: {
        description: "The upstream timed out. Not charged.",
        content: json(schemaRef("UpstreamError")),
      },
    },
  },
  paths: {
    "/apis": {
      get: {
        tags: ["Catalog"],
        summary: "List APIs in the catalog",
        description:
          "Listed, non-archived APIs. Paginate with limit/offset; ordering is stable within a " +
          "sort.",
        operationId: "listApis",
        parameters: [
          {
            name: "q",
            in: "query",
            description: "Case-insensitive search in name and description.",
            schema: { type: "string", maxLength: 100 },
          },
          {
            name: "tag",
            in: "query",
            description: "Repeatable. An API must carry every requested tag.",
            style: "form",
            explode: true,
            schema: { type: "array", maxItems: 10, items: { type: "string", maxLength: 32 } },
          },
          {
            name: "sort",
            in: "query",
            description: "`popular` ranks by charged calls in the last 7 days.",
            schema: {
              type: "string",
              enum: ["newest", "price_asc", "price_desc", "popular"],
              default: "newest",
            },
          },
          paramRef("Limit"),
          paramRef("Offset"),
        ],
        responses: {
          "200": {
            description: "One page of APIs.",
            content: json({ type: "array", items: schemaRef("PublicApi") }),
          },
          "400": responseRef("BadRequest"),
        },
      },
      post: {
        tags: ["API management"],
        summary: "Register an API",
        description:
          "Creates an unlisted API owned by the caller. Verify ownership, then list it. " +
          "Rate-limited per IP and per publisher wallet.",
        operationId: "createApi",
        security: [{ ApiKeyAuth: [] }],
        parameters: [paramRef("RequestTimestamp"), paramRef("RequestSignature")],
        requestBody: { required: true, content: json(schemaRef("CreateApiRequest")) },
        responses: {
          "201": {
            description: "The API was created.",
            headers: rateLimitHeaders,
            content: json(schemaRef("CreatedApi")),
          },
          "400": responseRef("BadRequest"),
          "401": responseRef("Unauthorized"),
          "429": responseRef("TooManyRequests"),
        },
      },
    },
    "/apis/{id}": {
      parameters: [paramRef("ApiId")],
      get: {
        tags: ["Catalog"],
        summary: "Get a listed API",
        operationId: "getApi",
        responses: {
          "200": { description: "The API.", content: json(schemaRef("PublicApi")) },
          "404": responseRef("NotFound"),
        },
      },
      patch: {
        tags: ["API management"],
        summary: "Update an API",
        operationId: "updateApi",
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          paramRef("RequestTimestamp"),
          paramRef("RequestSignature"),
          {
            name: "X-Payee-Timestamp",
            in: "header",
            description: "Required when changing walletAddress.",
            schema: { type: "string" },
          },
          {
            name: "X-Payee-Signature",
            in: "header",
            description:
              "Signature by the current payee wallet. Required when changing walletAddress.",
            schema: { type: "string" },
          },
        ],
        requestBody: { required: true, content: json(schemaRef("UpdateApiRequest")) },
        responses: {
          "200": { description: "The updated API.", content: json(schemaRef("OwnerApi")) },
          "400": responseRef("BadRequest"),
          "401": responseRef("Unauthorized"),
          "403": responseRef("Forbidden"),
          "404": responseRef("NotFound"),
        },
      },
      delete: {
        tags: ["API management"],
        summary: "Archive an API",
        description: "Unlists and hides the API. Its call history is kept for statistics.",
        operationId: "archiveApi",
        security: [{ ApiKeyAuth: [] }],
        parameters: [paramRef("RequestTimestamp"), paramRef("RequestSignature")],
        responses: {
          "200": { description: "The API was archived.", content: json(schemaRef("ArchivedApi")) },
          "401": responseRef("Unauthorized"),
          "404": responseRef("NotFound"),
        },
      },
    },
    "/apis/{id}/openapi.json": {
      parameters: [paramRef("ApiId")],
      get: {
        tags: ["Catalog"],
        summary: "Get an API's own OpenAPI document",
        description: "The provider's document, rewritten to point at the paid proxy URL.",
        operationId: "getApiOpenApi",
        responses: {
          "200": {
            description: "OpenAPI document.",
            content: json({ type: "object", additionalProperties: true }),
          },
          "404": responseRef("NotFound"),
        },
      },
    },
    "/apis/{id}/verify-ownership": {
      parameters: [paramRef("ApiId")],
      post: {
        tags: ["API management"],
        summary: "Verify upstream ownership",
        description:
          "Fetches ownershipVerification.url on the upstream origin and checks it serves " +
          "ownershipVerification.expectedContent.",
        operationId: "verifyApiOwnership",
        security: [{ ApiKeyAuth: [] }],
        parameters: [paramRef("RequestTimestamp"), paramRef("RequestSignature")],
        responses: {
          "200": {
            description: "The API with its updated ownership status.",
            content: json(schemaRef("OwnerApi")),
          },
          "400": responseRef("BadRequest"),
          "401": responseRef("Unauthorized"),
          "404": responseRef("NotFound"),
        },
      },
    },
    "/apis/{id}/test-upstream": {
      parameters: [paramRef("ApiId")],
      post: {
        tags: ["API management"],
        summary: "Test the saved upstream configuration",
        description:
          "Sends one GET to the upstream (healthPath when set, otherwise upstreamUrl) with the " +
          "saved secret header and query parameter. No payment is requested or settled. The " +
          "wait is capped at 10 seconds and the response body is never read. Returns status, " +
          "latency and content type only. Limited to 10 tests per minute per publisher.",
        operationId: "testApiUpstream",
        security: [{ ApiKeyAuth: [] }],
        parameters: [paramRef("RequestTimestamp"), paramRef("RequestSignature")],
        responses: {
          "200": {
            description: "Diagnostics for the test request.",
            content: json({
              type: "object",
              required: ["apiId", "ok", "status", "latencyMs", "error", "charged", "testedAt"],
              properties: {
                apiId: { type: "integer" },
                ok: { type: "boolean" },
                status: { type: "integer", nullable: true },
                latencyMs: { type: "integer" },
                contentType: { type: "string", nullable: true },
                request: {
                  type: "object",
                  properties: {
                    method: { type: "string", enum: ["GET"] },
                    path: { type: "string" },
                    usedHeaderSecret: { type: "boolean" },
                    usedQuerySecret: { type: "boolean" },
                  },
                },
                error: {
                  type: "object",
                  nullable: true,
                  properties: {
                    kind: {
                      type: "string",
                      enum: ["blocked", "timeout", "too_large", "network", "config"],
                    },
                    message: { type: "string" },
                  },
                },
                diagnosis: { type: "string" },
                charged: { type: "boolean", enum: [false] },
                testedAt: { type: "string", format: "date-time" },
              },
            }),
          },
          "401": responseRef("Unauthorized"),
          "404": responseRef("NotFound"),
          "429": responseRef("TooManyRequests"),
        },
      },
    },
    "/apis/{id}/stats": {
      parameters: [paramRef("ApiId")],
      get: {
        tags: ["Statistics"],
        summary: "Usage and revenue for one of your APIs",
        description:
          "Totals plus a page of recent calls, newest first. `from`/`to` restrict both the totals and the call history to the same window (from inclusive, to exclusive, at most 366 days). Archived APIs are included.",
        operationId: "getApiStats",
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          {
            name: "from",
            in: "query",
            description: "Start of the window, inclusive. ISO-8601 date or date-time.",
            schema: { type: "string", format: "date-time" },
          },
          {
            name: "to",
            in: "query",
            description: "End of the window, exclusive. ISO-8601 date or date-time.",
            schema: { type: "string", format: "date-time" },
          },
          {
            name: "limit",
            in: "query",
            description: "Calls per page.",
            schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
          },
          {
            name: "offset",
            in: "query",
            description: "Calls to skip.",
            schema: { type: "integer", minimum: 0, default: 0 },
          },
        ],
        responses: {
          "200": { description: "Statistics.", content: json(schemaRef("ApiStats")) },
          "400": responseRef("BadRequest"),
          "401": responseRef("Unauthorized"),
          "404": responseRef("NotFound"),
        },
      },
    },
    "/apis/{id}/stats/time-series": {
      parameters: [paramRef("ApiId")],
      get: {
        tags: ["Statistics"],
        summary: "Daily calls and revenue for one of your APIs",
        operationId: "getApiTimeSeries",
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          {
            name: "days",
            in: "query",
            description: "Window size. Other values fall back to 30.",
            schema: { type: "integer", enum: [7, 30, 90], default: 30 },
          },
        ],
        responses: {
          "200": { description: "Daily series.", content: json(schemaRef("ApiTimeSeries")) },
          "401": responseRef("Unauthorized"),
          "404": responseRef("NotFound"),
        },
      },
    },
    "/payers/{address}/calls": {
      parameters: [
        {
          name: "address",
          in: "path",
          required: true,
          description: "Payer wallet.",
          schema: stellarAddress,
        },
      ],
      get: {
        tags: ["Statistics"],
        summary: "Receipts for calls a wallet paid for",
        operationId: "listPayerCalls",
        security: [{ WalletSignature: [] }],
        parameters: [walletTimestampHeader, paramRef("Limit"), paramRef("Offset")],
        responses: {
          "200": { description: "One page of calls.", content: json(schemaRef("PayerCalls")) },
          "400": responseRef("BadRequest"),
          "401": walletSignatureRefused,
        },
      },
    },
    "/payers/{address}/entitlements": {
      parameters: [
        {
          name: "address",
          in: "path",
          required: true,
          description: "Payer wallet.",
          schema: stellarAddress,
        },
      ],
      get: {
        tags: ["Statistics"],
        summary: "Active access passes and prepaid credit balances held by a wallet",
        operationId: "getPayerEntitlements",
        security: [{ WalletSignature: [] }],
        parameters: [walletTimestampHeader],
        responses: {
          "200": {
            description: "What the wallet holds right now.",
            content: json(schemaRef("PayerEntitlements")),
          },
          "400": responseRef("BadRequest"),
          "401": walletSignatureRefused,
        },
      },
    },
    "/publishers": {
      post: {
        tags: ["Publishers"],
        summary: "Register as a publisher",
        description:
          "Creates a publisher and returns its API key (shown once). Public and rate-limited " +
          "per client IP (RATE_LIMIT_REGISTER_IP_MAX per RATE_LIMIT_REGISTER_IP_WINDOW_MS).",
        operationId: "registerPublisher",
        requestBody: { required: true, content: json(schemaRef("CreatePublisherRequest")) },
        responses: {
          "201": {
            description: "The publisher was created.",
            headers: rateLimitHeaders,
            content: json(schemaRef("RegisteredPublisher")),
          },
          "400": responseRef("BadRequest"),
          "409": {
            description: "Email already registered.",
            content: json(schemaRef("Error")),
          },
          "429": responseRef("TooManyRequests"),
        },
      },
    },
    "/publishers/me/apis": {
      get: {
        tags: ["API management"],
        summary: "List your APIs",
        description: "All non-archived APIs owned by the caller, listed or not, newest first.",
        operationId: "listMyApis",
        security: [{ ApiKeyAuth: [] }],
        responses: {
          "200": {
            description: "Your APIs.",
            content: json({ type: "array", items: schemaRef("OwnerApi") }),
          },
          "401": responseRef("Unauthorized"),
        },
      },
    },
    "/api/{id}/pass": {
      parameters: [paramRef("ApiId")],
      post: {
        tags: ["Proxy"],
        summary: "Buy a time-limited access pass",
        description:
          "Pays passPrice once via x402 on the gateway's Stellar network; calls from the same " +
          "wallet are then free for passDurationMs, until the pass expires. Without a payment the gateway answers with the 402 challenge.",
        operationId: "buyAccessPass",
        security: [{}, { X402Payment: [] }],
        responses: {
          "200": {
            description: "A pass is already active.",
            content: json(schemaRef("AccessPass")),
          },
          "201": { description: "Pass activated.", content: json(schemaRef("AccessPass")) },
          "402": responseRef("PaymentRequired"),
          "404": responseRef("NotFound"),
          "502": {
            description: "The payment facilitator could not verify or settle the payment.",
          },
        },
      },
    },
    "/api/{id}": proxyPathItem(false),
    "/api/{id}/{path}": proxyPathItem(true),
  },
};

export default openApiSpec;
