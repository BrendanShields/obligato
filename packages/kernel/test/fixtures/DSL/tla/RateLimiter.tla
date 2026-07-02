---- MODULE RateLimiter ----
\* DSL-5 structural fixture. Model-checking in CI lands with Phase 4 tooling;
\* Phase 1 requires only that the referenced model file exists.
VARIABLES window_counts

Init == window_counts = [c \in {} |-> 0]
Next == UNCHANGED window_counts
====
