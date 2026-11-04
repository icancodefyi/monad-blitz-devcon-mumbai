import { randomUUID } from "node:crypto";
import { start } from "workflow/api";
import { formatEther } from "viem";
import { DONADS_AI_POLICY } from "@/lib/ai-policy";
import { pendingApprovals } from "@/lib/approvals";
import { canDeleteTaskHistory } from "@/lib/task-history";

import type {
  BrandProfile,
  CommerceCompletedTask,
  FlowCompletedTask,
  OperatorCompletedTask,
  OperatorRoutine,
  OperatorTaskInput,
  ScoutCompletedTask,
  Task,
} from "@/lib/donads-api";
import { authenticate, createChallenge, logout, SESSION_COOKIE, verifyChallenge } from "@/server/auth";
import { monToWei } from "@/server/bots";
import {
  getProfile,
  getAiUsageSince,
  getRoutine,
  getTask,
  getSwapQuote as loadSwapQuote,
  completeSwapQuote,
  countVerifiedTestnetReceipts,
  deleteTaskHistory,
  deleteTelegramLink,
  getTelegramLink,
  getOfferProposal,
  getOrderMatch,
  cancelOwnerOrders,
  listSchedules,
  stopSchedules,
  putOfferProposal,
  listRoutines,
  listMissions,
  getMission,
  listTasks,
  putProfile,
  putRoutine,
  putSwapQuote,
  updateTask,
} from "@/server/database";
import { assertTrustedOrigin, PublicApiError, readJsonObject, safeFailure } from "@/server/api-security";
import { geminiConfigured } from "@/server/gemini";
import { planTask } from "@/server/ai-planner";
import { taskEvent } from "@/server/donads-types";
import { encodeErc20Transfer, formatTokenAmount, monadRpc, readErc20Balance } from "@/server/monad";
import { createAndExecuteTask } from "@/server/tasks";
import { operatorWorkflow } from "@/workflows/operator";
import { quoteUniswapSwap } from "@/server/uniswap";
import { sendCheckpointNotifications } from "@/server/checkpoint-notifications";
import { applyFlowDecision, type FlowDecision } from "@/server/flow-decision";
import { mainnetReadiness } from "@/server/mainnet-readiness";
import { assessThreat } from "@/server/threat-intelligence";
import { createTelegramLink, sendTelegramMatch, sendTelegramOffer, telegramConfigured } from "@/server/telegram";
import { placeOrder } from "@/server/orders";
import { sellerEscrowCommand } from "@/lib/orders";
import { findOffer, rankOffers } from "@/lib/offers";
import { createSchedule } from "@/server/schedules";

export const maxDuration = 300;

type Context = { params: Promise<{ path?: string[] }> };

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function failure(cause: unknown): Response {
  const safe = safeFailure(cause);
  if (safe.status >= 500) console.error("DONADS API internal error", cause);
  return json({ error: safe.message, code: safe.code }, safe.status);
}

async function body(request: Request): Promise<Record<string, unknown>> {
  return readJsonObject(request);
}

async function ownedTask(ownerId: string, id: string): Promise<Task> {
  const task = await getTask(ownerId, id);
  if (!task) throw new Error("Task not found.");
  return task;
}

async function commerceAction(ownerId: string, id: string, request: Request): Promise<Response> {
  const task = await ownedTask(ownerId, id) as CommerceCompletedTask;
  if (task.bot !== "commerce" || task.status.state !== "completed") throw new Error("Commerce task not found.");
  const action = await body(request);
  const workflow = task.status.data.workflow;
  if (workflow.state !== "awaiting_approval") return json(task);
  if (action.action === "approve") {
    if (String(action.approved_total_atomic) !== workflow.total_atomic) throw new Error("Approval amount does not match the exact selected total.");
    workflow.state = "authorized";
    workflow.approval_id = randomUUID();
    workflow.approved_at_ms = Date.now();
    workflow.audit_history.push({ sequence: workflow.audit_history.length + 1, event: "intent_authorized", detail: "User authorized the exact intent; no payment or order was submitted.", at_ms: Date.now() });
    task.status.summary = "Commerce recorded exact intent authorization. A merchant invoice and wallet payment are still required.";
  } else if (action.action === "reject") {
    workflow.state = "rejected";
    workflow.audit_history.push({ sequence: workflow.audit_history.length + 1, event: "intent_rejected", detail: "User rejected the commerce intent.", at_ms: Date.now() });
    task.status.summary = "Commerce intent rejected; no payment or order occurred.";
  } else throw new Error("Unsupported commerce action.");
  task.updated_at_ms = Date.now();
  task.events.push(taskEvent(task.events, String(action.action), task.status.summary));
  await updateTask(task);
  return json(task);
}

async function flowAction(ownerId: string, id: string, request: Request): Promise<Response> {
  const task = await ownedTask(ownerId, id) as FlowCompletedTask;
  if (task.bot !== "flow" || task.status.state !== "completed") throw new Error("Flow task not found.");
  const action = await body(request);
  let decision: FlowDecision;
  if (action.action === "approve") decision = { action: "approve", note: typeof action.note === "string" ? action.note : undefined };
  else if (action.action === "reject") decision = { action: "reject", reason: typeof action.reason === "string" ? action.reason : undefined };
  else throw new Error("Unsupported Flow action.");
  const duplicatePrevented = applyFlowDecision(task, decision, "web");
  if (!duplicatePrevented) {
    await updateTask(task);
    await sendCheckpointNotifications(task);
  }
  return json({ task, duplicate_prevented: duplicatePrevented });
}

async function recordFlowSubmission(ownerId: string, id: string, request: Request): Promise<Response> {
  const task = await ownedTask(ownerId, id) as FlowCompletedTask;
  if (task.bot !== "flow" || task.status.state !== "completed") throw new Error("Flow task not found.");
  const payload = await body(request);
  const hash = typeof payload.transaction_hash === "string" ? payload.transaction_hash.toLowerCase() : "";
  const payoutIndex = Number(payload.payout_index ?? 0);
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error("A valid transaction hash is required.");
  const workflow = task.status.data.workflow;
  if (!Number.isInteger(payoutIndex) || payoutIndex < 0 || payoutIndex >= workflow.payouts.length) throw new Error("A valid payout index is required.");
  const submissions = workflow.submissions ?? (workflow.submission ? [{ payout_index: 0, ...workflow.submission }] : []);
  const previous = submissions.find((item) => item.payout_index === payoutIndex);
  if (previous) {
    if (previous.transaction_hash !== hash) throw new Error("A different transaction is already recorded for this payout.");
    return json(task);
  }
  if (!["authorized", "submitted"].includes(workflow.state)) throw new Error("The exact transfer must be authorized before recording a wallet submission.");
  if (submissions.some((item) => item.transaction_hash === hash)) throw new Error("One transaction cannot satisfy multiple payouts.");
  const submission = { payout_index: payoutIndex, transaction_hash: hash, submitted_at_ms: Date.now() };
  submissions.push(submission); submissions.sort((left, right) => left.payout_index - right.payout_index);
  workflow.submissions = submissions;
  if (payoutIndex === 0) workflow.submission = { transaction_hash: hash, submitted_at_ms: submission.submitted_at_ms };
  workflow.state = submissions.length === workflow.payouts.length ? "submitted" : "authorized";
  workflow.audit_history.push({ sequence: workflow.audit_history.length + 1, event: "transaction_submitted", detail: `Wallet returned transaction ${payoutIndex + 1}/${workflow.payouts.length}; receipt verification is pending.`, at_ms: Date.now() });
  task.status.summary = `Flow recorded ${submissions.length}/${workflow.payouts.length} wallet submission(s).`;
  task.updated_at_ms = Date.now();
  task.events.push(taskEvent(task.events, "transaction_submitted", task.status.summary));
  await updateTask(task);
  return json(task);
}

async function confirmFlow(ownerId: string, id: string, request: Request): Promise<Response> {
  const task = await ownedTask(ownerId, id) as FlowCompletedTask;
  if (task.bot !== "flow" || task.status.state !== "completed") throw new Error("Flow task not found.");
  const payload = await body(request);
  const hash = typeof payload.transaction_hash === "string" ? payload.transaction_hash.toLowerCase() : "";
  const payoutIndex = Number(payload.payout_index ?? 0);
  if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error("A valid transaction hash is required.");
  const workflow = task.status.data.workflow;
  if (!Number.isInteger(payoutIndex) || payoutIndex < 0 || payoutIndex >= workflow.payouts.length) throw new Error("A valid payout index is required.");
  const executions = workflow.executions ?? (workflow.execution ? [{ payout_index: 0, ...workflow.execution }] : []);
  const previousExecution = executions.find((item) => item.payout_index === payoutIndex);
  if (previousExecution) {
    if (previousExecution.transaction_hash !== hash) throw new Error("A different transaction is already verified for this payout.");
    return json(task);
  }
  const submissions = workflow.submissions ?? (workflow.submission ? [{ payout_index: 0, ...workflow.submission }] : []);
  const submission = submissions.find((item) => item.payout_index === payoutIndex);
  if (workflow.state !== "submitted" || submission?.transaction_hash !== hash) throw new Error("Transaction hash does not match the recorded wallet submission.");
  const transaction = await monadRpc("eth_getTransactionByHash", [hash]) as Record<string, string> | null;
  const receipt = await monadRpc("eth_getTransactionReceipt", [hash]) as Record<string, string> | null;
  if (!transaction || !receipt?.blockNumber) throw new Error("Transaction has not been mined yet.");
  if (receipt.status !== "0x1") throw new Error("Monad receipt reports a reverted transaction.");
  const payout = workflow.payouts[payoutIndex];
  if (transaction.from?.toLowerCase() !== workflow.payer) throw new Error("Mined transaction sender does not match the approved payer.");
  let senderBalanceAfter: bigint | null = null;
  let recipientBalanceAfter: bigint | null = null;
  if (workflow.transfer_kind === "erc20" && workflow.token && payout.amount_atomic) {
    const expectedInput = encodeErc20Transfer(payout.recipient_address, BigInt(payout.amount_atomic)).toLowerCase();
    if (transaction.to?.toLowerCase() !== workflow.token.contract || BigInt(transaction.value ?? "0x0") !== BigInt(0) || transaction.input?.toLowerCase() !== expectedInput) throw new Error("Mined ERC-20 transaction does not match the approved contract, recipient, amount, or calldata policy.");
    [senderBalanceAfter, recipientBalanceAfter] = await Promise.all([
      readErc20Balance(workflow.token.contract, workflow.payer),
      readErc20Balance(workflow.token.contract, payout.recipient_address),
    ]);
    const amountAtomic = BigInt(payout.amount_atomic);
    if (recipientBalanceAfter - BigInt(workflow.token.recipient_balance_before_atomic) !== amountAtomic) throw new Error("Recipient token balance delta does not match the approved amount.");
    if (BigInt(workflow.token.sender_balance_before_atomic) - senderBalanceAfter < amountAtomic) throw new Error("Sender token balance did not decrease by the approved amount.");
  } else if (transaction.to?.toLowerCase() !== payout.recipient_address || BigInt(transaction.value) !== monToWei(payout.amount) || !["0x", "0x0", undefined].includes(transaction.input)) {
    throw new Error("Mined native transaction does not match the approved recipient, amount, or calldata policy.");
  }
  const execution = { payout_index: payoutIndex, transaction_hash: hash.toLowerCase(), block_number: Number(BigInt(receipt.blockNumber)), confirmed_at_ms: Date.now(), ...(senderBalanceAfter === null ? {} : { sender_balance_after_atomic: senderBalanceAfter.toString(), recipient_balance_after_atomic: recipientBalanceAfter!.toString() }) };
  executions.push(execution); executions.sort((left, right) => left.payout_index - right.payout_index);
  workflow.executions = executions;
  if (payoutIndex === 0) workflow.execution = { transaction_hash: execution.transaction_hash, block_number: execution.block_number, confirmed_at_ms: execution.confirmed_at_ms, ...(senderBalanceAfter === null ? {} : { sender_balance_after_atomic: senderBalanceAfter.toString(), recipient_balance_after_atomic: recipientBalanceAfter!.toString() }) };
  workflow.state = executions.length === workflow.payouts.length ? "confirmed" : "submitted";
  workflow.audit_history.push({ sequence: workflow.audit_history.length + 1, event: "transaction_confirmed", detail: `Monad receipt ${payoutIndex + 1}/${workflow.payouts.length} verified in block ${execution.block_number}.`, at_ms: Date.now() });
  task.status.summary = workflow.state === "confirmed" ? `Flow independently verified all ${workflow.payouts.length} Monad Testnet transaction receipt(s).` : `Flow verified ${executions.length}/${workflow.payouts.length} Monad Testnet receipt(s).`;
  task.updated_at_ms = Date.now();
  task.events.push(taskEvent(task.events, "transaction_confirmed", task.status.summary));
  await updateTask(task);
  return json(task);
}

async function confirmEscrowVerification(ownerId: string, id: string, request: Request): Promise<Response> {
  const task = await ownedTask(ownerId, id) as ScoutCompletedTask;
  if (task.bot !== "scout" || task.status.state !== "completed") throw new Error("Escrow verification task not found.");
  const verification = task.status.data.deliverableVerification;
  if (!verification || verification.recommendedAction === "none" || !verification.actionCalldata) throw new Error("No approved escrow action is prepared for this verification.");
  const payload = await body(request);
  const hash = typeof payload.transaction_hash === "string" ? payload.transaction_hash.toLowerCase() : "";
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error("A valid transaction hash is required.");
  if (verification.execution?.transactionHash === hash) return json(task);
  if (verification.execution) throw new Error("A different verified transaction is already attached to this deliverable check.");
  const [transaction, receipt] = await Promise.all([
    monadRpc("eth_getTransactionByHash", [hash]) as Promise<Record<string, string> | null>,
    monadRpc("eth_getTransactionReceipt", [hash]) as Promise<Record<string, string> | null>,
  ]);
  if (!transaction || !receipt?.blockNumber) throw new Error("Escrow transaction has not been mined yet.");
  if (receipt.status !== "0x1") throw new Error("Monad receipt reports a reverted escrow transaction.");
  if (transaction.from?.toLowerCase() !== ownerId || transaction.to?.toLowerCase() !== verification.escrowAddress || transaction.input?.toLowerCase() !== verification.actionCalldata.toLowerCase() || BigInt(transaction.value ?? "0x0") !== BigInt(0)) {
    throw new Error("Mined escrow transaction does not match the verified wallet, contract, action calldata, or zero-value policy.");
  }
  verification.execution = { transactionHash: hash, blockNumber: Number(BigInt(receipt.blockNumber)), confirmedAtMs: Date.now() };
  task.status.summary = `Flow verified the ${verification.recommendedAction} transaction for the screened escrow deliverable.`;
  task.updated_at_ms = Date.now();
  task.events.push(taskEvent(task.events, "escrow_action_confirmed", task.status.summary));
  await updateTask(task);
  return json(task);
}

async function minedTransaction(hash: string): Promise<{ transaction: Record<string, string>; receipt: Record<string, string> }> {
  const [transaction, receipt] = await Promise.all([
    monadRpc("eth_getTransactionByHash", [hash]) as Promise<Record<string, string> | null>,
    monadRpc("eth_getTransactionReceipt", [hash]) as Promise<Record<string, string> | null>,
  ]);
  if (!transaction || !receipt?.blockNumber) throw new Error("Transaction has not been mined yet.");
  if (receipt.status !== "0x1") throw new Error("Monad receipt reports a reverted transaction.");
  return { transaction, receipt };
}

async function confirmSwap(ownerId: string, request: Request): Promise<Response> {
  const payload = await body(request);
  const quoteId = String(payload.quote_id ?? "");
  const approvalHash = String(payload.approval_transaction_hash ?? "").toLowerCase();
  const swapHash = String(payload.swap_transaction_hash ?? "").toLowerCase();
  if (!/^[0-9a-f-]{36}$/i.test(quoteId) || !/^0x[0-9a-f]{64}$/.test(approvalHash) || !/^0x[0-9a-f]{64}$/.test(swapHash)) throw new Error("Valid quote, approval, and swap transaction identifiers are required.");
  if (approvalHash === swapHash) throw new Error("Approval and swap must be separate transactions.");
  const quote = await loadSwapQuote(ownerId, quoteId);
  if (!quote) throw new Error("Swap quote not found.");
  if (quote.execution) return json(quote);
  if (quote.blocked) throw new Error(quote.blocked_reason ?? "Sentinel blocked this swap.");

  const [{ transaction: approval }, { transaction: swap, receipt: swapReceipt }] = await Promise.all([
    minedTransaction(approvalHash), minedTransaction(swapHash),
  ]);
  if (approval.from?.toLowerCase() !== ownerId || approval.to?.toLowerCase() !== quote.token_in.contract || BigInt(approval.value ?? "0x0") !== BigInt(0) || approval.input?.toLowerCase() !== quote.approval_calldata.toLowerCase()) throw new Error("Mined approval does not match the exact token, router, amount, or wallet policy.");
  if (swap.from?.toLowerCase() !== ownerId || swap.to?.toLowerCase() !== quote.router || BigInt(swap.value ?? "0x0") !== BigInt(0) || swap.input?.toLowerCase() !== quote.swap_calldata.toLowerCase()) throw new Error("Mined swap does not match the exact router, recipient, amount, fee tier, or minimum-output policy.");
  const block = await monadRpc("eth_getBlockByNumber", [swapReceipt.blockNumber, false]) as Record<string, string> | null;
  if (!block?.timestamp || Number(BigInt(block.timestamp)) * 1_000 > quote.expires_at_ms) throw new Error("Swap was mined after its quote expired and cannot be certified.");

  const [inputAfter, outputAfter] = await Promise.all([
    readErc20Balance(quote.token_in.contract, ownerId),
    readErc20Balance(quote.token_out.contract, ownerId),
  ]);
  const inputSpent = BigInt(quote.input_balance_before_atomic) - inputAfter;
  const outputReceived = outputAfter - BigInt(quote.output_balance_before_atomic);
  if (inputSpent !== BigInt(quote.token_in.amount_atomic)) throw new Error("Input-token balance delta does not match the quoted exact-input amount.");
  if (outputReceived < BigInt(quote.token_out.minimum_amount_atomic)) throw new Error("Output-token balance delta is below the approved minimum output.");
  quote.execution = {
    approval_transaction_hash: approvalHash, swap_transaction_hash: swapHash,
    block_number: Number(BigInt(swapReceipt.blockNumber)), output_amount_atomic: outputReceived.toString(), confirmed_at_ms: Date.now(),
  };
  await completeSwapQuote(ownerId, quote);
  return json(quote);
}

async function operatorAction(ownerId: string, id: string, request: Request): Promise<Response> {
  const task = await ownedTask(ownerId, id) as OperatorCompletedTask;
  if (task.bot !== "operator" || task.status.state !== "completed") throw new Error("Operator task not found.");
  const payload = await body(request);
  if (payload.action === "cancel") {
    task.status.data.workflow.cancellation_requested = true;
    task.status.data.workflow.state = "cancelling";
    task.updated_at_ms = Date.now();
    await updateTask(task);
    return json(task);
  }
  if (payload.action === "retry_failed") {
    task.status.data.workflow.steps.filter((step) => ["failed", "blocked", "cancelled"].includes(step.status)).forEach((step) => { step.status = "pending"; step.error = null; step.summary = null; step.task_id = null; });
    task.status.data.workflow.cancellation_requested = false;
  } else if (payload.action !== "start") throw new Error("Unsupported Operator action.");
  task.status.data.workflow.state = "running";
  task.status.data.workflow.started_at_ms ??= Date.now();
  task.updated_at_ms = Date.now();
  await updateTask(task);
  await start(operatorWorkflow, [ownerId, task.id]);
  return json(task);
}

async function route(request: Request, context: Context): Promise<Response> {
  assertTrustedOrigin(request);
  const segments = (await context.params).path ?? [];
  const method = request.method;
  if (method === "GET" && segments[0] === "health") return json({ status: "ok", network: "testnet", chain_id: 10143, persistence: "postgres", deployment: "vercel" });
  if (method === "GET" && segments[0] === "bots") return json(["scout", "commerce", "growth", "flow", "operator", "sentinel"]);
  if (method === "POST" && segments.join("/") === "auth/challenge") {
    const payload = await body(request);
    return json(await createChallenge(request, String(payload.address ?? "")), 201);
  }
  if (method === "POST" && segments.join("/") === "auth/verify") {
    const payload = await body(request);
    const session = await verifyChallenge(String(payload.address ?? ""), String(payload.signature ?? "") as `0x${string}`);
    const response = json(session);
    const secure = (request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "")) === "https";
    response.headers.append("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(session.access_token)}; Path=/; Max-Age=43200; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`);
    return response;
  }
  if (method === "POST" && segments.join("/") === "auth/logout") {
    await logout(request);
    return new Response(null, { status: 204, headers: { "Set-Cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax` } });
  }

  const { ownerId } = await authenticate(request);
  if (method === "GET" && segments.join("/") === "auth/session") return json({ owner_id: ownerId });
  if (method === "GET" && segments.join("/") === "approvals") return json(pendingApprovals(await listTasks(ownerId, 100)));
  if (method === "POST" && segments.join("/") === "schedules") {
    const payload = await body(request);
    try { return json(await createSchedule(ownerId, { recipients: payload.recipients, amount_each: payload.amount_each, interval_minutes: payload.interval_minutes, first_run_ms: payload.first_run_ms }), 201); }
    catch (cause) { throw new PublicApiError(400, "INVALID_SCHEDULE", cause instanceof Error ? cause.message : "The schedule is invalid."); }
  }
  if (method === "GET" && segments.join("/") === "schedules") return json(await listSchedules(ownerId));
  if (method === "DELETE" && segments.join("/") === "schedules") return json({ stopped: await stopSchedules(ownerId) });
  if (method === "POST" && segments.join("/") === "orders") {
    const payload = await body(request);
    const side = payload.side === "sell" ? "sell" : payload.side === "buy" ? "buy" : null;
    if (!side) throw new PublicApiError(400, "INVALID_ORDER", "Side must be buy or sell.");
    if (!telegramConfigured() || !await getTelegramLink(ownerId)) {
      throw new PublicApiError(409, "TELEGRAM_NOT_CONNECTED", "Connect Telegram first: open the bell icon and choose Connect under Telegram approvals. No order was placed.");
    }
    let placed;
    try { placed = await placeOrder(ownerId, { side, amount: String(payload.amount ?? ""), price: String(payload.price ?? "") }); }
    catch (cause) { throw new PublicApiError(400, "INVALID_ORDER", cause instanceof Error ? cause.message : "The order is invalid."); }
    if (placed.match) {
      await sendTelegramMatch(ownerId, placed.match);
      if (placed.counterpart_match) await sendTelegramMatch(placed.counterpart_match.owner_id, placed.counterpart_match).catch(() => undefined);
    }
    return json({ order_id: placed.order_id, match: placed.match ? { match_id: placed.match.match_id, side: placed.match.side, amount: placed.match.amount, price: placed.match.price, counterparty_name: placed.match.counterparty_name, counterparty_demo: placed.match.counterparty_demo } : null }, 201);
  }
  if (method === "DELETE" && segments.join("/") === "orders") return json({ cancelled: await cancelOwnerOrders(ownerId) });
  if (method === "GET" && segments[0] === "orders" && segments[1] === "matches" && segments.length === 3) {
    const match = await getOrderMatch(ownerId, segments[2]);
    if (!match) throw new PublicApiError(404, "MATCH_NOT_FOUND", "Match not found.");
    const escrowCommand = match.decision === "go" && match.side === "sell"
      ? sellerEscrowCommand({ side: "sell", amount: match.amount, price: match.price }, { id: match.counterparty_id, side: "buy", amount: match.amount, price: match.price, name: match.counterparty_name, address: match.counterparty_address as `0x${string}`, demo: match.counterparty_demo }, match.match_id)
      : null;
    return json({ match_id: match.match_id, side: match.side, amount: match.amount, price: match.price, decision: match.decision, counterparty_name: match.counterparty_name, counterparty_demo: match.counterparty_demo, escrow_command: escrowCommand });
  }
  if (method === "POST" && segments.join("/") === "offers/proposals") {
    const payload = await body(request);
    const offer = findOffer(String(payload.offer_id ?? ""));
    if (!offer) throw new PublicApiError(400, "OFFER_NOT_FOUND", "That offer does not exist.");
    const ranked = rankOffers(offer.category);
    const rankedOffer = ranked.find((item) => item.id === offer.id);
    if (!rankedOffer) throw new PublicApiError(400, "OFFER_NOT_FOUND", "That offer is not available.");
    if (!telegramConfigured() || !await getTelegramLink(ownerId)) {
      throw new PublicApiError(409, "TELEGRAM_NOT_CONNECTED", "Connect Telegram first: open the bell icon and choose Connect under Telegram approvals. No offer was sent.");
    }
    const proposalId = randomUUID();
    await putOfferProposal(ownerId, proposalId, offer.id);
    await sendTelegramOffer(ownerId, proposalId, rankedOffer, ranked.length - 1);
    return json({ proposal_id: proposalId, offer_id: offer.id, decision: "pending" }, 201);
  }
  if (method === "GET" && segments[0] === "offers" && segments[1] === "proposals" && segments.length === 3) {
    const proposal = await getOfferProposal(ownerId, segments[2]);
    if (!proposal) throw new PublicApiError(404, "PROPOSAL_NOT_FOUND", "Offer proposal not found.");
    return json(proposal);
  }
  if (method === "GET" && segments.join("/") === "connectors/telegram") {
    const link = await getTelegramLink(ownerId);
    return json({ configured: telegramConfigured(), connected: Boolean(link), username: link?.username ?? null, linked_at_ms: link?.linked_at_ms ?? null });
  }
  if (method === "POST" && segments.join("/") === "connectors/telegram/link") return json(await createTelegramLink(ownerId), 201);
  if (method === "DELETE" && segments.join("/") === "connectors/telegram") { await deleteTelegramLink(ownerId); return new Response(null, { status: 204 }); }
  if (method === "GET" && segments.join("/") === "readiness/mainnet") return json(mainnetReadiness(await countVerifiedTestnetReceipts(ownerId)));
  if (method === "GET" && segments[0] === "missions" && segments.length === 1) return json(await listMissions(ownerId, Math.min(100, Math.max(1, Number(new URL(request.url).searchParams.get("limit") ?? 20)))));
  if (method === "GET" && segments[0] === "missions" && segments.length === 2) {
    const mission = await getMission(ownerId, segments[1]);
    if (!mission) throw new Error("Mission not found.");
    return json(mission);
  }
  if (method === "GET" && segments.join("/") === "wallet/balance") {
    const value = String(await monadRpc("eth_getBalance", [ownerId, "latest"]));
    return json({ address: ownerId, chain_id: 10143, network: "Monad Testnet", symbol: "MON", balance_atomic: BigInt(value).toString(), balance_mon: formatEther(BigInt(value)) });
  }
  if (method === "GET" && segments.join("/") === "wallet/token-balances") {
    const tasks = await listTasks(ownerId, 100);
    const tokens = new Map<string, { contract: string; symbol: string; decimals: number }>();
    for (const task of tasks) {
      if (task.status.state !== "completed" || task.bot !== "flow") continue;
      const token = task.status.data.workflow.token;
      if (token) tokens.set(token.contract, { contract: token.contract, symbol: token.symbol, decimals: token.decimals });
    }
    const balances = await Promise.all([...tokens.values()].slice(0, 10).map(async (token) => {
      const value = await readErc20Balance(token.contract, ownerId);
      return { ...token, balance_atomic: value.toString(), balance_formatted: formatTokenAmount(value, token.decimals) };
    }));
    return json(balances);
  }
  if (method === "GET" && segments.join("/") === "ai/usage") {
    const now = new Date();
    const resetAtMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    const used = await getAiUsageSince(ownerId, resetAtMs - 24 * 60 * 60 * 1_000);
    return json({
      configured: geminiConfigured(), provider: "gemini", model: process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash",
      used_today: used, remaining_today: Math.max(0, DONADS_AI_POLICY.requestsPerDayPerWallet - used), resets_at_ms: resetAtMs,
      limits: DONADS_AI_POLICY,
    });
  }
  if (method === "POST" && segments.join("/") === "security/preflight") {
    const payload = await body(request);
    const text = String(payload.text ?? "").trim();
    if (!text) throw new Error("Text or a link is required for Sentinel preflight.");
    if (text.length > 20_000) throw new Error("Sentinel preflight input exceeds 20,000 characters.");
    const urls = Array.isArray(payload.urls) ? payload.urls.map(String).slice(0, 10) : undefined;
    const transactionData = typeof payload.transaction_data === "string" ? payload.transaction_data : undefined;
    return json(assessThreat({ text, urls, transactionData }));
  }
  if (method === "POST" && segments.join("/") === "ai/plan") {
    const payload = await body(request);
    const prompt = String(payload.prompt ?? "").trim();
    if (!prompt) throw new Error("A task prompt is required.");
    const attachments = Array.isArray(payload.attachments) ? payload.attachments.map((value) => {
      if (!value || typeof value !== "object") throw new Error("Invalid AI attachment.");
      const item = value as Record<string, unknown>; const data = String(item.data ?? ""); const mimeType = String(item.mime_type ?? "");
      if (!/^image\//.test(mimeType) && mimeType !== "application/pdf") throw new Error("Gemini attachments must be images or PDFs.");
      if (Buffer.byteLength(data, "base64") > DONADS_AI_POLICY.maxAttachmentBytes) throw new Error("An attachment exceeds the 10 MB limit.");
      return { name: String(item.name ?? "attachment"), mimeType, data };
    }) : [];
    if (attachments.length > DONADS_AI_POLICY.maxAttachmentsPerTask) throw new Error("A task accepts up to 5 attachments.");
    return json(await planTask(ownerId, prompt, attachments));
  }
  if (method === "POST" && segments.join("/") === "dex/quote") {
    const payload = await body(request);
    const quote = await quoteUniswapSwap({
      tokenIn: String(payload.token_in ?? ""), tokenOut: String(payload.token_out ?? ""),
      amount: String(payload.amount ?? ""), recipient: ownerId,
      slippageBps: Number(payload.slippage_bps), maxPriceImpactBps: Number(payload.max_price_impact_bps),
    });
    await putSwapQuote(ownerId, quote);
    return json(quote);
  }
  if (method === "POST" && segments.join("/") === "dex/confirm") return confirmSwap(ownerId, request);
  if (segments[0] === "tasks" && segments.length === 1 && method === "POST") return json(await createAndExecuteTask(ownerId, await body(request)), 201);
  if (segments[0] === "tasks" && segments.length === 1 && method === "GET") return json(await listTasks(ownerId, Math.min(100, Math.max(1, Number(new URL(request.url).searchParams.get("limit") ?? 20)))));
  if (segments[0] === "tasks" && segments.length === 2 && method === "GET") return json(await ownedTask(ownerId, segments[1]));
  if (segments[0] === "tasks" && segments.length === 2 && method === "DELETE") {
    const task = await ownedTask(ownerId, segments[1]);
    const deletion = canDeleteTaskHistory(task);
    if (!deletion.allowed) throw new PublicApiError(409, "TASK_ACTIVE", deletion.reason ?? "This task cannot be deleted yet.");
    if (!await deleteTaskHistory(ownerId, task.id)) throw new PublicApiError(404, "NOT_FOUND", "Task not found.");
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } });
  }
  if (segments[0] === "tasks" && segments[2] === "commerce-actions" && method === "POST") return commerceAction(ownerId, segments[1], request);
  if (segments[0] === "tasks" && segments[2] === "flow-actions" && method === "POST") return flowAction(ownerId, segments[1], request);
  if (segments[0] === "tasks" && segments[2] === "flow-submission" && method === "POST") return recordFlowSubmission(ownerId, segments[1], request);
  if (segments[0] === "tasks" && segments[2] === "flow-transaction" && method === "POST") return confirmFlow(ownerId, segments[1], request);
  if (segments[0] === "tasks" && segments[2] === "escrow-verification" && method === "POST") return confirmEscrowVerification(ownerId, segments[1], request);
  if (segments[0] === "tasks" && segments[2] === "operator-actions" && method === "POST") return operatorAction(ownerId, segments[1], request);
  if (segments[0] === "tasks" && segments[2] === "feedback" && method === "POST") {
    const task = await ownedTask(ownerId, segments[1]);
    const payload = await body(request);
    if (![1, 5].includes(Number(payload.rating))) throw new Error("Feedback rating must be 1 or 5.");
    task.feedback = { rating: Number(payload.rating), note: typeof payload.note === "string" ? payload.note : null, submitted_at_ms: Date.now() };
    task.updated_at_ms = Date.now(); await updateTask(task); return json(task);
  }
  if (segments[0] === "brand-profiles" && segments.length === 2 && method === "GET") {
    const profile = await getProfile(ownerId, decodeURIComponent(segments[1]));
    if (!profile) throw new Error("Brand profile not found."); return json(profile);
  }
  if (segments[0] === "brand-profiles" && segments.length === 2 && method === "PUT") {
    const payload = await body(request) as unknown as BrandProfile;
    const previous = await getProfile(ownerId, decodeURIComponent(segments[1]));
    const profile = { ...payload, id: decodeURIComponent(segments[1]), version: (previous?.version ?? 0) + 1, updated_at_ms: Date.now() };
    await putProfile(ownerId, profile); return json(profile);
  }
  if (segments[0] === "tasks" && segments[2] === "routine" && method === "POST") {
    const task = await ownedTask(ownerId, segments[1]) as OperatorCompletedTask;
    if (task.bot !== "operator" || task.status.data.workflow.state !== "completed") throw new Error("Only a completed Operator run can become a routine.");
    const payload = await body(request); const id = String(payload.id ?? "").trim(); if (!id) throw new Error("Routine id is required.");
    const previous = await getRoutine(ownerId, id); const now = Date.now();
    const routine: OperatorRoutine = { id, name: String(payload.name ?? id), description: String(payload.description ?? ""), version: (previous?.version ?? 0) + 1, created_at_ms: previous?.created_at_ms ?? now, updated_at_ms: now, input: task.input as OperatorTaskInput };
    await putRoutine(ownerId, routine); return json(routine, 201);
  }
  if (segments[0] === "routines" && segments.length === 1 && method === "GET") return json(await listRoutines(ownerId));
  if (segments[0] === "routines" && segments[2] === "runs" && method === "POST") {
    const routine = await getRoutine(ownerId, decodeURIComponent(segments[1])); if (!routine) throw new Error("Routine not found.");
    return json(await createAndExecuteTask(ownerId, { prompt: routine.input.objective, bot: "operator", input: routine.input }), 201);
  }
  return json({ error: "Route not found." }, 404);
}

async function handle(request: Request, context: Context): Promise<Response> {
  try { return await route(request, context); } catch (cause) { return failure(cause); }
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
