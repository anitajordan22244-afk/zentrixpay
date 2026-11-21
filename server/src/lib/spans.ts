import { type Attributes, SpanStatusCode, trace } from "@opentelemetry/api";

// Span helper for the paid-call path (#218). Without an SDK (no
// OTEL_EXPORTER_OTLP_ENDPOINT) the API tracer is a no-op, so this costs nothing.
const tracer = trace.getTracer("zentrixpay-server");

export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn();
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}
