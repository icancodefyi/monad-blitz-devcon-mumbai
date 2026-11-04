# DONADS architecture decisions

## ADR-001: Mission is the durable unit of work

Every accepted task belongs to one Mission. A Mission owns ordered events,
execution steps, approval checkpoints, typed transaction intents and verified
receipts. State transitions are versioned and append-only events provide the
audit timeline.

## ADR-002: Models plan; deterministic code authorizes

LLMs may classify requests, propose steps, summarize sources and improve tone.
They cannot set financial authority, bypass a policy, select a signer or decide
that a transaction succeeded. Financial facts are derived from typed inputs,
simulation and independent chain verification.

## ADR-003: Non-custodial by default

The user wallet signs value-moving actions. Future session permissions must be
expiring, revocable, allowlisted and bounded by per-action and cumulative limits.
No LLM or browser worker receives a private key.

## ADR-004: Testnet evidence precedes mainnet

Mainnet stays disabled until the acceptance matrix, funded testnet workflows,
recovery tests, contract analysis, monitoring and independent review are complete.
The mainnet readiness endpoint reports evidence; it does not activate execution.

## ADR-005: Same-origin backend-for-frontend

The browser uses same-origin `/api/v1` routes. Routes are public network surfaces
and therefore rely on authentication, authorization, origin validation, payload
limits, quotas and redacted errors—not obscurity.

## ADR-006: Connected apps use least privilege

App integrations use revocable OAuth scopes and encrypted server-side tokens.
They may initiate work or contribute artifacts, but cannot approve wallet actions.
Inbound webhooks require authenticity and replay validation.

## ADR-007: Reports are optional artifacts

The chat timeline is the primary result. PDF is an explicit export generated from
verified Mission evidence, not an automatic attachment for every response.
