# Contract fuzz and invariant evidence — 2026-11-03

This record covers local automated assurance for the current DONADS policy-vault
and escrow contracts. It is engineering evidence, not an independent audit and
not authorization to enable Monad Mainnet execution.

## Toolchain

- Foundry Forge: `1.9.0` (`6056c58c727c164a5a4a1a059e935e80f043aeaf`)
- Official Windows archive SHA-256:
  `2b02444d46c9218fe2e6be66015265ce131fe6b7c384e33e630b00f9a0bff072`
- Solidity: `0.8.24`
- Local test chain ID: `10143` (Monad Testnet)
- Fuzz configuration: 512 runs per property
- Invariant configuration: 128 runs, depth 64

The archive checksum was verified before execution. Tests used an isolated local
EVM; no RPC URL, wallet, private key, or live chain was involved.

## Results

`forge test` passed all 18 tests with zero failures:

- Policy vault bounded-transfer accounting: 512 fuzz runs.
- Policy vault action-hash nonce binding: 512 fuzz runs.
- Escrow constructor/funding/terms preservation: 512 fuzz runs.
- Policy vault invariants: 128 runs and 8,192 calls.
- Escrow invariants: 128 runs and 8,192 calls.
- Unit coverage includes replay rejection, per-transaction and daily limits,
  recipient allowlisting, session revocation, emergency pause, ownership and
  exact-action authorization.

The project-level Hardhat Solidity runner also passed 21 tests, including 256
runs for each fuzz/invariant property. CI executes this runner on every push and
pull request.

## Enforced invariants

- Vault ownership cannot change through exposed execution paths.
- Session spending cannot exceed the configured daily limit.
- The daily limit cannot be lower than the per-transaction limit.
- Active escrow retains exactly the funded amount.
- Terminal escrow states retain no funds.
- Escrow buyer, seller, arbiter and terms hash remain immutable.

## Remaining assurance work

- Add the native Forge run to a checksum-pinned CI toolchain.
- Add static analysis and document all findings.
- Obtain an independent smart-contract security review.
- Run application penetration, prompt-injection and malicious-file testing.
- Exercise pause, revocation, multisig and recovery procedures on deployed
  Testnet contracts.
