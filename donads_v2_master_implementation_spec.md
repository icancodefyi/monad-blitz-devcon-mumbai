# DONADS V2 — Crypto-Native Implementation Specification

Status: active direction. This specification supersedes every fiat, payout-provider, virtual-card, gift-card, QR-to-INR, and simulated-payment proposal.

## 1. Product invariant

The user pays in crypto on Monad and the merchant must directly accept the configured crypto asset through an authorized checkout integration. DONADS must not convert crypto to fiat, initiate bank or UPI payouts, or claim support for a retailer that does not accept crypto.

No task may report a successful transaction, purchase, message, or form submission without externally verifiable proof from the responsible network or service.

## 2. Current system

- Scout: supplied-URL cited research.
- Commerce: crypto-offer validation and exact authorization intent.
- Growth: local campaign drafts.
- Flow: exact Monad transfer intent validation and approval.
- Operator: persistent dependency-aware task coordination.
- Sentinel: EVM bytecode risk scanning.

There are six implemented specialists. The remaining four bots require separate product definitions and user approval before implementation.

## 3. Target transaction workflow

1. Scout finds an offer from an allowlisted merchant that explicitly accepts MON or an approved Monad token.
2. Commerce verifies product, stock, merchant domain, asset, atomic amount, checkout recipient, and checkout expiry.
3. Sentinel validates the merchant, recipient, token, amount, user policy, session limits, and task provenance.
4. The user reviews the exact action or has previously enabled a bounded on-chain policy.
5. A user wallet or delegated KMS/HSM signer signs the exact Monad transaction.
6. Flow broadcasts it and records the real network transaction hash.
7. Flow waits for a successful receipt and verifies chain ID, destination, value/calldata, logs, and confirmations.
8. Commerce submits or observes the merchant checkout using the verified transaction proof.
9. Commerce completes only after receiving a real merchant order ID or signed receipt.
10. Operator persists the action passport, transaction receipt, merchant receipt, and recovery state.

## 4. Required on-chain components

Implement `contracts/src/DonadsPolicyVault.sol` with:

- Owner-controlled delegated session keys.
- Session expiration and nonce/replay protection.
- Per-transaction and rolling/daily asset limits.
- Token, merchant contract, and recipient allowlists.
- Exact calldata/action hash binding.
- Revocation and emergency pause.
- Escrow only when the merchant protocol supports deterministic settlement/refund.
- Events for policy changes, authorization, execution, revocation, settlement, and refund.

Use Foundry tests, fuzzing, invariants, testnet deployment rehearsal, source verification, and an independent audit before mainnet.

## 5. Sentinel policy guard

Sentinel must become a mandatory middleware gate, not an optional sidebar tool. It must verify:

- Requested network and chain ID.
- Recipient and merchant allowlists.
- Token contract and decimals.
- Exact amount and budget.
- Session-key scope and expiration.
- Nonce and idempotency key.
- Checkout domain and merchant proof.
- Shipping-address hash where relevant.
- Prompt-injection and untrusted-page instructions.
- User approval or valid on-chain automatic-execution policy.

The existing bytecode scanner remains an auxiliary Sentinel module.

## 6. Real execution requirements

- Browser wallet connector for user-approved actions, or a narrowly delegated key stored in KMS/HSM.
- Monad testnet RPC and chain-ID enforcement.
- Native MON transfer support.
- Reviewed ERC-20 transfer support.
- Gas estimation, nonce management, fee bounds, broadcast, receipt polling, confirmation policy, and replacement/recovery.
- No private key in frontend storage, repository files, ordinary logs, or committed `.env` files.
- No generated or placeholder transaction hashes.

## 7. Merchant requirements

Each supported merchant must provide one of:

- An authorized crypto checkout API.
- A smart-contract checkout protocol.
- A signed invoice binding merchant, chain, asset, recipient, amount, expiry, cart, and order reference.

Browser automation alone is insufficient proof that the merchant accepts a crypto payment. Retailers without a supported crypto checkout remain unsupported.

## 8. Browser worker

Use an authenticated Playwright worker only for allowlisted merchants and permitted workflows. It must provide:

- Domain allowlisting.
- Persistent profile encryption.
- Structured offer/cart extraction.
- Checkout-invoice extraction.
- Human handoff for CAPTCHA or unsupported authentication.
- Confirmation screenshot and DOM artifact.
- No interpretation of webpage text as system instructions.
- Crash recovery and selector-version tests.

## 9. Persistence and infrastructure

Replace development JSON storage before production with:

- PostgreSQL transactions and migrations.
- Durable queue and scheduler.
- Encrypted object storage for artifacts.
- Idempotency and reconciliation workers.
- Authentication, task ownership, RBAC, restrictive CORS, CSRF protection, and rate limiting.
- Secret manager plus KMS/HSM.
- Logs, metrics, traces, alerts, backups, and incident runbooks.

## 10. Completion tests

Test at minimum:

- Wrong chain, recipient, token, decimals, amount, nonce, and merchant.
- Stale or changed checkout invoice.
- Duplicate broadcast and server restart.
- Dropped, reverted, replaced, and delayed transactions.
- Transaction success but merchant rejection.
- Merchant success but local persistence failure.
- Policy revocation and kill switch during execution.
- Prompt injection and malicious checkout pages.
- Refund and recovery where the merchant protocol supports them.

## 11. Environment contract

```env
DONADS_NETWORK=testnet
MONAD_RPC_URL=
DONADS_BIND_ADDRESS=127.0.0.1:8080
DONADS_TASK_STORE=data/tasks.json
DONADS_PROFILE_STORE=data/profiles.json

DONADS_POLICY_VAULT_ADDRESS=
DONADS_SIGNER_KEY_REFERENCE=

DONADS_CRYPTO_MERCHANT_URL=
DONADS_CRYPTO_MERCHANT_TOKEN=

DONADS_BROWSER_WORKER_URL=http://127.0.0.1:8091
DONADS_BROWSER_USER_DATA_DIR=
DONADS_INTERNAL_WORKER_SECRET=
```

## 12. Delivery order

1. Wallet connection and testnet enforcement.
2. Policy vault and Foundry tests.
3. Mandatory Sentinel guard.
4. Real native MON testnet transfer and receipt verification.
5. ERC-20 transfer support.
6. One authorized crypto merchant integration.
7. End-to-end order and recovery tests.
8. Production persistence and security controls.
9. External security review.
10. Mainnet only after explicit approval.
