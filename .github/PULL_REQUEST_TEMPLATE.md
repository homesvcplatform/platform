## What & why
<!-- Link the gate / errata / ADR this implements. -->

## Gate
- [ ] This PR stays within the currently approved gate (no work from a later gate)

## Security checklist (required)
- [ ] Every new/changed endpoint declares an authorization policy (default deny) and has authZ-matrix tests
- [ ] Mutating endpoints declare idempotency behaviour
- [ ] No client-supplied prices, states, roles or technician assignments are trusted
- [ ] No secrets, tokens or credentials added (gitleaks clean). No production credentials anywhere
- [ ] No PII/OTP/PIN/token/address in logs, traces, errors or analytics (allowlist logger only)
- [ ] New DB columns carry a classification tag (P/I/C/R) and encryption where required
- [ ] Migrations are forward-only, reviewed, and lock-safe (squawk clean)
- [ ] Business invariants touched have tests (INV-xx / L-xx)
- [ ] Module boundaries respected (dependency-cruiser clean, no new module edges without an ADR)
- [ ] Synthetic data only. No real customer PII, payments, telephony or KYC

## Testing evidence
<!-- Commands run and results. -->
