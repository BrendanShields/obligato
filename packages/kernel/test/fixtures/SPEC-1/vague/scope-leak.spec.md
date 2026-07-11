# Vague corpus: check predicate reaches outside its declarations (DSL-3)

```obspec
kind: component
id: quota
tier: T0
authority: authored
events: [usage_reported]
```

```obspec
kind: domain
id: Usage
type: int
unit: bytes
min: 0
max: 1000000
```

```obspec
kind: clause
id: QTA-1
ears: event
trigger: usage_reported
text: When usage is reported, the quota service shall cap stored usage at the limit.
inputs: { usage: Usage }
observe: [stored.value]
check: |
  (ctx) => ctx.expect(ctx.stored.value <= globalLimit)
```
