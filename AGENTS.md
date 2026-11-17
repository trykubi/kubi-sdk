# kubi-sdk: rules for agents

- The design is the kubi folder beside this repository (`../kubi`, product.md section SDK). This repository is
  public once on GitHub: nothing private goes in it, no internal routes, hosts or names.
- Types only from the public spec through `scripts/gen.sh`; never edit `spec/` or `src/types.gen.ts`.
- Never retry a call the API doesn't mark `retryable`, and never a 504. A resend keeps its `Idempotency-Key`.
- No telemetry, no install scripts.
- `./check.sh` passes before every commit. Commit after each change, saying what and why.
