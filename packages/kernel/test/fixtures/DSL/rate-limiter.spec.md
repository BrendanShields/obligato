# Obspec: rate-limiter

Normative test fixture #1 for the Phase 1 compiler (obspec DSL §4). This
prose is deliberately not load-bearing (DSL-1) — only the fenced blocks are.

```obspec
kind: component
id: rate-limiter
tier: T1
authority: authored
state:
  - name: window_counts
    mutated_by: [request_received, window_rolled]
events: [request_received, window_rolled]
domains_of_concern: []
```

The limiter's input domains, generator-facing (DSL-2):

```obspec
kind: domain
id: RequestRate
type: int
unit: requests_per_minute
min: 0
max: 100000
```

```obspec
kind: domain
id: WindowCount
type: int
unit: requests
min: 0
max: 100000
```

The one behavioral clause (obspec DSL §2.3):

```obspec
kind: clause
id: RL-1
ears: event
trigger: request_received
text: >
  When a request arrives and the caller's window count equals the limit,
  the rate limiter shall reject the request with retry_after set to the
  window remainder.
inputs: { rate: RequestRate, count: WindowCount }
observe: [response.status, response.retry_after, window_remainder]
check: |
  (ctx) => ctx.when(ctx.count === ctx.rate)
             .expect(ctx.response.status === 429
                  && ctx.response.retry_after === ctx.window_remainder)
```

And the safety invariant (obspec DSL §2.4):

```obspec
kind: invariant
id: RL-INV-1
text: The sum of window counts never exceeds limit × active_callers.
over: [window_counts]
check: |
  (s) => [...s.window_counts.values()].reduce((a, b) => a + b, 0)
           <= s.limit * s.window_counts.size
model: tla/RateLimiter.tla
```
