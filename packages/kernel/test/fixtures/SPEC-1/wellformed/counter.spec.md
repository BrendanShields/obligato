# Well-formed corpus: counter

```kelspec
kind: component
id: counter
tier: T0
authority: authored
state:
  - name: total
    mutated_by: [incremented]
events: [incremented]
```

```kelspec
kind: domain
id: Step
type: int
unit: count
min: 1
max: 1000
```

```kelspec
kind: clause
id: CNT-1
ears: event
trigger: incremented
text: When an increment arrives, the counter shall grow by exactly the step.
inputs: { step: Step }
observe: [total.before, total.after]
check: |
  (ctx) => ctx.expect(ctx.total.after === ctx.total.before + ctx.step)
```
