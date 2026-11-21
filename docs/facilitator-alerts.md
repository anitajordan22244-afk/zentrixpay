# Facilitator failure alerts (issue #219)

The x402 facilitator sits on the payment path. When it is down, every paid call
fails. Facilitator failures are counted separately from upstream API failures:

    zentrixpay_facilitator_requests_total{operation, outcome, reason}

- `operation`: `verify` or `settle`
- `outcome`: `ok`, `rejected` (the facilitator said the payment is invalid), or `error` (the call itself failed)
- `reason` (on `error`): `unreachable` (network failure or timeout), `facilitator_5xx`, `facilitator_4xx`, `other`

Failed calls are also logged with the same `reason` on the `x402_verify` /
`x402_settle` error events, so logs and metrics agree.

## Failure rate

    sum(rate(zentrixpay_facilitator_requests_total{outcome="error"}[5m]))
      / sum(rate(zentrixpay_facilitator_requests_total[5m]))

## Alert rule

Fires when more than 20% of facilitator calls error for 5 minutes:

```yaml
groups:
  - name: zentrixpay-facilitator
    rules:
      - alert: ZentrixFacilitatorFailing
        expr: |
          sum(rate(zentrixpay_facilitator_requests_total{outcome="error"}[5m]))
            / sum(rate(zentrixpay_facilitator_requests_total[5m])) > 0.2
        for: 5m
        labels:
          severity: page
        annotations:
          summary: "x402 facilitator error rate above 20%"
          description: >-
            Paid calls are failing at the payment step. Check the reason label:
            unreachable or facilitator_5xx points at the facilitator, not at
            upstream APIs.
```

To see which failure class dominates, split the same query by `reason`.
