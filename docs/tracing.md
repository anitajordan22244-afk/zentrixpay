# Tracing the paid-call path (issue #218)

Each paid call produces one trace. The spans, in order:

| Span                      | Covers                                      | Attribute           |
| ------------------------- | ------------------------------------------- | ------------------- |
| `paywall.lookup`          | Loading the API row before the paywall runs | `zentrixpay.api.id` |
| `x402.facilitator.verify` | Facilitator verify call                     | `x402.network`      |
| `upstream.call`           | Upstream request (buffered path)            | `zentrixpay.api.id` |
| `x402.facilitator.settle` | Facilitator settle call                     | `x402.network`      |

Spans are only exported when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Without it,
tracing is a no-op.

## View traces locally with Jaeger

1. Start Jaeger (it is behind a compose profile, so it does not start by default):

   ```sh
   docker compose --profile tracing up -d jaeger
   ```

2. Run the server with the OTLP endpoint set:

   ```sh
   export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces
   export OTEL_SERVICE_NAME=zentrixpay-server   # optional
   pnpm --filter @zentrixpay/server dev
   ```

3. Make a paid call, then open http://localhost:16686, pick the
   `zentrixpay-server` service, and open the newest trace. Filter by the
   `zentrixpay.api.id` tag to find calls to one API.
