# Gateway metrics (issue #217)

The gateway exposes Prometheus metrics at `GET /metrics`. The gateway-specific
series below cover paid proxy traffic. Labels are bounded: none of them carry an
API id, so cardinality does not grow with the number of listed APIs.

| Metric                                         | Type      | Labels                                    | Meaning                                                           |
| ---------------------------------------------- | --------- | ----------------------------------------- | ----------------------------------------------------------------- |
| `zentrixpay_gateway_proxied_calls_total`       | counter   | `status_class` (`2xx`, `4xx`, `5xx`, ...) | Proxied API calls by response status class.                       |
| `zentrixpay_gateway_charged_calls_total`       | counter   | `charged` (`true`/`false`)                | Proxied calls, split by whether the caller was charged.           |
| `zentrixpay_gateway_upstream_duration_seconds` | histogram | none                                      | Upstream round-trip latency on the buffered proxy path.           |
| `zentrixpay_gateway_settlement_failures_total` | counter   | none                                      | x402 settlements that failed or were rejected by the facilitator. |
| `zentrixpay_gateway_payment_required_total`    | counter   | none                                      | `402 Payment Required` challenges served.                         |
| `zentrixpay_gateway_credit_spends_total`       | counter   | none                                      | Charged proxied calls paid from prepaid API credits.              |

## Useful queries

- Payment failure rate: `rate(zentrixpay_gateway_settlement_failures_total[5m])`
- Share of calls that were charged: `sum(rate(zentrixpay_gateway_charged_calls_total{charged="true"}[5m])) / sum(rate(zentrixpay_gateway_charged_calls_total[5m]))`
- Upstream p95 latency: `histogram_quantile(0.95, sum(rate(zentrixpay_gateway_upstream_duration_seconds_bucket[5m])) by (le))`
- Server error rate on proxied calls: `rate(zentrixpay_gateway_proxied_calls_total{status_class="5xx"}[5m])`
