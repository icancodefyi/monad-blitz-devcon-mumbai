# DONADS Project Definition

DONADS is a crypto-native agent execution system for Monad. It coordinates bounded specialists, requires explicit or on-chain policy authorization for sensitive actions, and reports completion only when the responsible network or external service provides verifiable evidence.

## Active product rules

- Crypto only; no fiat payout rail, card workaround, gift card, or payment simulation.
- Monad Testnet before mainnet.
- No fabricated transaction hash, order ID, message ID, citation, or completion state.
- A crypto payment is not a purchase until the merchant returns a real order receipt.
- Unsupported merchants fail closed.
- New bot types require product-owner approval before implementation.

## Current specialists

1. Scout — supplied-source research and citations.
2. Commerce — exact purchase authorization plus verified merchant invoice, payment, and order-receipt lifecycle.
3. Growth — brand-constrained campaign drafts.
4. Flow — wallet-approved native MON execution and RPC receipt verification.
5. Operator — persistent orchestration with parallel dependency waves and versioned reusable routines.
6. Sentinel — bytecode risk analysis plus mandatory native-MON Flow policy checks.

The current interface contains six specialists. The former ten-chain-bot concept is retained only as historical product exploration; it is not the active implementation contract. Four future bot slots remain undefined until the user approves each bot.

## Current delivery milestone

Complete one native MON transfer on Monad Testnet from a connected user wallet, verify its mined receipt server-side, and then require Sentinel and `DonadsPolicyVault` for bounded delegated execution.

## Completion roadmap

1. Native MON wallet execution and receipt verification.
2. Policy vault compilation, unit tests, audit, and testnet deployment.
3. Extend Sentinel with policy-vault state and merchant-domain checks.
4. One authorized crypto-accepting merchant integration.
5. Real merchant order receipt and recovery flow.
6. ERC-20 support after token and decimal validation.
7. Live Scout search and allowlisted browser worker.
8. Approved communication connectors.
9. PostgreSQL, durable jobs, authentication, observability, and backups.
10. Security review and explicit mainnet approval.

See `README.md` for setup and the current capability matrix. See `donads_v2_master_implementation_spec.md` for the implementation contract.
