# Monad mainnet readiness runbook

DONADS mainnet execution is disabled. Completing this document does not itself
authorize deployment or execution.

## Gate 1 — Freeze the supported workflow

- One typed native/ERC-20 transfer workflow.
- Exact chain, sender, recipient, amount, asset and calldata policy.
- Explicit user approval or a separately reviewed restricted session policy.
- Idempotent submission and independent receipt verification.

## Gate 2 — Produce testnet evidence

- At least ten successful, independently verified receipts.
- Rejected approval, insufficient funds, revert, delayed receipt, duplicate
  submission and restart recovery tests.
- Explorer links and balance changes stored in Mission receipts.
- Browser and mobile approval E2E evidence.

## Gate 3 — Contract assurance

- Unit, fuzz and invariant suites. The current local run is recorded in
  [`security/contract-fuzz-invariants-2026-11-03.md`](security/contract-fuzz-invariants-2026-11-03.md);
  independent review and CI hardening remain required.
- Static analysis with documented false-positive review.
- Exact action authorization bound to chain, vault, session, asset, recipient,
  amount, calldata hash, nonce and expiry.
- External review and remediation evidence.
- Verified contract source and deterministic deployment records.

## Gate 4 — Production custody and operations

- Multisig-controlled administrative and pause authority.
- KMS/HSM-backed restricted session signing; no raw key environment variables.
- Rotation, revocation and disaster-recovery drills.
- Dedicated RPC with fallback, monitoring and rate limits.
- Database backups and restore exercise.
- Security alerts, provider spend alerts and incident runbook.

## Gate 5 — Canary deployment

1. Deploy and verify contracts on chain ID 143.
2. Keep all sessions disabled and pause active.
3. Verify ownership, multisig and explorer metadata.
4. Enable an allowlisted internal wallet with minimal caps.
5. Complete a low-value canary Mission.
6. Reconcile chain state, receipt and balances independently.
7. Raise limits gradually only after an explicit review.

## Rollback

- Pause vault execution.
- Revoke every active session.
- Disable mainnet routing at the server feature gate.
- Preserve append-only evidence and transaction hashes.
- Notify affected users and begin the incident runbook.
