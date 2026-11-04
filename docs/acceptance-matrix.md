# DONADS 2.0 acceptance matrix

Status values: `PASS`, `PARTIAL`, `BLOCKED`, `NOT STARTED`.

| Capability | Acceptance evidence | Status |
|---|---|---|
| Wallet cancellation recovery | Closing the QR restores the connect screen within 1 second | PARTIAL — local unit coverage; deployed E2E required |
| Persistent wallet session | Refresh restores the 12-hour server session without a new signature | PASS |
| Persistent Mission | Mission, events and task linkage survive restart and concurrent reads | NOT STARTED |
| Native MON transfer | Exact intent, approval, wallet hash, receipt and explorer link | PARTIAL — implementation present; funded run required |
| ERC-20 transfer | Exact calldata plus sender/recipient balance deltas | PARTIAL — implementation present; funded run required |
| Swap | Quote, slippage, simulation, exact calldata and receipt/balance verification | BLOCKED — verified testnet router/configuration required |
| P2P escrow | Funding, release/refund and events verified on testnet | PARTIAL — contract exists; deployment workflow required |
| Policy vault | Expiring session, allowlist, caps, revocation and exact action authorization | BLOCKED — exact authorization binding required |
| Mobile approval | Push deep-links to a wallet approval screen and resumes Mission | PARTIAL — push/inbox exists; action E2E required |
| Connected apps | OAuth state/PKCE, encrypted tokens, revocation and audit trail | NOT STARTED |
| Mission report | Chat result plus optional structured PDF using verified evidence | PARTIAL |
| Abuse protection | Wallet, IP/edge, payload, concurrency and provider quotas | PARTIAL — wallet/provider limits present |
| Browser E2E | Playwright covers auth cancel, reconnect, history and approval flow | NOT STARTED |
| Contract assurance | Unit, fuzz, invariant, static analysis and independent review | PARTIAL — deterministic unit tests pass |
| Mainnet readiness | Every mandatory gate is backed by a dated artifact | BLOCKED |

## First complete demonstration

1. User signs in on Monad Testnet.
2. User asks DONADS to send an exact native MON amount.
3. DONADS creates a Mission and typed transaction intent.
4. Sentinel validates chain, sender, recipient, amount and empty calldata.
5. Sentinel preflight blocks deterministic phishing/scam signals before model planning or wallet execution and explicitly reports its coverage limits.
6. UI shows estimated gas, total required balance and approval conditions.
7. Mobile/in-app checkpoint requests approval.
8. Owner wallet signs and broadcasts.
9. Server verifies the mined receipt and exact transaction fields.
10. Mission completes with duration, Monad explorer link and optional PDF.
11. Refreshing the app restores the complete timeline.
