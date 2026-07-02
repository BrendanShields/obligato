# Well-formed corpus: greeter (includes a signed-unverifiable clause, SPEC-3)

```kelspec
kind: component
id: greeter
tier: T0
authority: authored
events: [name_submitted]
```

```kelspec
kind: domain
id: Name
type: string
max_length: 40
```

```kelspec
kind: clause
id: GRT-1
ears: event
trigger: name_submitted
text: When a name is submitted, the greeter shall include it verbatim in the greeting.
inputs: { name: Name }
observe: [greeting]
check: |
  (ctx) => ctx.expect(ctx.greeting.includes(ctx.name))
```

```kelspec
kind: clause
id: GRT-2
ears: ubiquitous
text: The greeting shall feel warm and welcoming.
unverifiable:
  signed_by: brendan
  reason: subjective tone judgment; no property, model, or metamorphic relation exists
```
