# Vague corpus: "handles errors gracefully"

```kelspec
kind: component
id: importer
tier: T0
authority: authored
events: [file_received]
```

```kelspec
kind: clause
id: IMP-1
ears: event
trigger: file_received
text: When a malformed file arrives, the importer shall handle the error gracefully.
```

```kelspec
kind: clause
id: IMP-2
ears: ubiquitous
text: The importer shall be robust.
```
