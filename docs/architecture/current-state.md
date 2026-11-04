# DONADS 2.0 current state

_Assessment date: 2026-11-03_

## Runtime architecture

DONADS is a Monad-first, non-custodial task system. The production web path is a
Next.js 16 application deployed as a Vercel frontend and same-origin API. Neon
PostgreSQL stores wallet sessions, task history, model usage, routines, push
subscriptions and swap quotes. Reown/WalletConnect and injected EVM wallets are
used for signatures. Gemini is optional and is used only for planning and
language enhancement. Deterministic TypeScript and Solidity code remains the
authority for financial policy, transaction construction and receipt checks.

```text
Browser / mobile PWA
  -> Next.js chat and approval UI
  -> /api/v1 authenticated route handler
       -> Neon PostgreSQL
       -> Gemini model gateway
       -> Vercel Workflow (Operator)
       -> Monad Testnet JSON-RPC
       -> Telegram (approvals, offers, alerts)
  -> user wallet signs exact transactions
  -> Monad Testnet contracts and recipients
```

The Rust workspace contains reference specialist and dispatcher implementations.
It is tested in CI, but it is not the primary Vercel production backend. New
production behavior must not be implemented independently in both paths without
an explicit ownership decision.

## Verified functionality

- EIP-191 wallet challenge authentication with one-time, expiring challenges.
- HttpOnly, wallet-scoped server sessions and persistent history.
- Six specialists: Scout, Commerce, Growth, Flow, Operator and Sentinel.
- Authenticated task prompts pass through deterministic Sentinel URL, social-engineering and dangerous-approval preflight before model planning or wallet execution.
- Gemini planning with distributed per-wallet quotas and deterministic fallback.
- Native MON and ERC-20 transfer intents, explicit approval and receipt checks.
- Exact sender, recipient, amount, calldata and token balance-delta verification.
- Operator dependency execution through Vercel Workflow.
- Testnet DEX quote/confirmation guardrails when a configured adapter is present.
- Telegram approvals with exact transfer details, an in-app approval inbox, best-offer Go/Skip, scheduled payments, and wallet-watch alerts.
- Optional structured PDF task reports and explorer links.
- Policy-vault and escrow Solidity prototypes with deterministic tests.

## Known limitations

1. Tasks are persisted, but there is no normalized Mission/step/attempt/intent/
   approval/receipt model covering every workflow.
2. Most specialists still execute synchronously in a request. Only Operator is
   durable through Vercel Workflow.
3. Browser-driven contract actions are not independently reconciled after a
   restart, replacement or delayed receipt.
4. The policy vault needs exact owner-authorized action binding before delegated
   execution can be considered safe.
5. There is no live physical-product merchant connector.
6. Connected apps (OAuth) are not part of the product; Telegram is the only external channel.
7. Mainnet execution is intentionally disabled.
8. Browser E2E, funded testnet, mobile push and contract invariant suites are not
   yet complete.

## Custody boundary

DONADS does not receive seed phrases or user private keys. Model output cannot
authorize or sign a transaction. Until restricted session permissions are proven,
the owner wallet must sign every value-moving action. Public RPC URLs, routes and
transaction requests are observable in browser developer tools; private provider
keys, database credentials, token secrets and signing material must remain on the
server.
