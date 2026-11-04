import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { FlowCompletedTask, Task } from "@/lib/donads-api";
import { pendingApprovalForTask, pendingApprovals, type PendingApproval } from "@/lib/approvals";
import { claimTelegramUpdate, consumeTelegramLinkCode, decideOfferProposal, getTask, getTelegramLink, getTelegramOwner, listTasks, putTelegramLinkCode, takeRateLimit, updateTask } from "@/server/database";
import { applyFlowDecision } from "@/server/flow-decision";
import { DEMO_ARBITER, DEMO_REFUND_HOURS, findOffer, type RankedOffer } from "@/lib/offers";

const LINK_TTL_MS = 10 * 60 * 1_000;

function setting(name: string): string { return process.env[name]?.trim() ?? ""; }

export function telegramConfigured(): boolean {
  return Boolean(setting("TELEGRAM_BOT_TOKEN") && /^[A-Za-z0-9_]{5,32}$/.test(setting("TELEGRAM_BOT_USERNAME")) && setting("TELEGRAM_WEBHOOK_SECRET").length >= 32 && /^https:\/\//.test(setting("DONADS_PUBLIC_APP_URL")));
}

export function telegramWebhookAuthorized(value: string | null): boolean {
  const expected = setting("TELEGRAM_WEBHOOK_SECRET");
  if (!expected || !value) return false;
  const left = Buffer.from(value); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function telegramStartCode(text: string): string | null {
  const match = text.trim().match(/^\/start(?:@[A-Za-z0-9_]+)?\s+(dn_[A-Za-z0-9_-]{12,64})$/);
  return match?.[1] ?? null;
}

// Callback data is limited to 64 bytes by Telegram. The version stamp is the
// task's updated_at_ms in base 36, so a button stops working as soon as the
// intent changes anywhere (web app, another tap, or a newer message).
const DECISION_PATTERN = /^f([ar]):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9a-z]{1,11})$/;

export type TelegramFlowDecision = { action: "approve" | "reject"; task_id: string; version: string };

export function flowDecisionData(action: "approve" | "reject", task: Pick<Task, "id" | "updated_at_ms">): string {
  return `f${action === "approve" ? "a" : "r"}:${task.id}:${task.updated_at_ms.toString(36)}`;
}

export function parseFlowDecision(data: unknown): TelegramFlowDecision | null {
  if (typeof data !== "string") return null;
  const match = data.match(DECISION_PATTERN);
  if (!match) return null;
  return { action: match[1] === "a" ? "approve" : "reject", task_id: match[2], version: match[3] };
}

const OFFER_PATTERN = /^o([gs]):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function offerDecisionData(decision: "go" | "skip", proposalId: string): string {
  return `o${decision === "go" ? "g" : "s"}:${proposalId}`;
}

export function parseOfferDecision(data: unknown): { decision: "go" | "skip"; proposal_id: string } | null {
  if (typeof data !== "string") return null;
  const match = data.match(OFFER_PATTERN);
  return match ? { decision: match[1] === "g" ? "go" : "skip", proposal_id: match[2] } : null;
}

export function offerProposalMessage(offer: RankedOffer, alternatives: number): string {
  return [
    "DONADS found an offer. Go?",
    "",
    `${offer.title}`,
    `Seller: ${offer.seller_name}`,
    `Seller wallet: ${offer.seller_address}`,
    `Price: ${offer.price_mon} MON`,
    `Delivery: within ${offer.delivery_hours}h`,
    `Completed deals: ${offer.completed_deals}`,
    `Why this one: ${offer.reasons[0]}${alternatives ? ` (ranked against ${alternatives} other offer${alternatives === 1 ? "" : "s"})` : ""}`,
    "",
    `Go locks ${offer.price_mon} MON in an escrow for this seller, refundable after ${DEMO_REFUND_HOURS}h, with arbiter ${DEMO_ARBITER}. Your wallet still has to sign it.`,
    "Test seller on Monad Testnet.",
  ].join("\n");
}

export async function sendTelegramOffer(ownerId: string, proposalId: string, offer: RankedOffer, alternatives: number): Promise<void> {
  if (!telegramConfigured()) throw new Error("Telegram is not configured on this server.");
  const link = await getTelegramLink(ownerId);
  if (!link) throw new Error("Connect Telegram first: open the bell icon and choose Connect under Telegram approvals.");
  await telegramApi("sendMessage", {
    chat_id: link.chat_id,
    text: offerProposalMessage(offer, alternatives),
    reply_markup: { inline_keyboard: [[{ text: "✅ Go", callback_data: offerDecisionData("go", proposalId) }, { text: "⏭ Skip", callback_data: offerDecisionData("skip", proposalId) }]] },
  });
}

/** Exact, unabbreviated values so the owner can approve from Telegram alone. */
export function flowReviewMessage(task: FlowCompletedTask): string {
  const workflow = task.status.data.workflow;
  const lines = workflow.payouts.map((payout, index) => {
    const label = payout.recipient_name && payout.recipient_name !== payout.recipient_address ? ` (${payout.recipient_name})` : "";
    return `${index + 1}. ${payout.amount} ${payout.asset}${label}\n   to ${payout.recipient_address}`;
  });
  const total = workflow.totals.map((item) => `${item.amount} ${item.asset}`).join(" + ");
  const token = workflow.transfer_kind === "erc20" && workflow.token ? `\nToken contract: ${workflow.token.contract}` : "";
  return [
    "DONADS: approve this exact transfer?",
    "",
    `Network: ${workflow.network} (chain ${workflow.chain_id})`,
    `From: ${workflow.payer}${token}`,
    "",
    ...lines,
    "",
    `Total: ${total}`,
    "",
    "Approving records your decision only. Your wallet must still sign the transaction, and DONADS verifies the receipt on Monad before anything is marked done.",
  ].join("\n");
}

function codeHash(code: string): string { return createHash("sha256").update(code).digest("hex"); }

export async function createTelegramLink(ownerId: string): Promise<{ url: string; expires_at_ms: number }> {
  if (!telegramConfigured()) throw new Error("Telegram notifications are not configured.");
  // Local development polls Telegram instead (npm run telegram:poll). A registered
  // webhook would block polling and send updates to the deployed app instead.
  if (telegramDelivery() === "webhook") await ensureTelegramWebhook();
  const code = `dn_${randomBytes(18).toString("base64url")}`;
  const expiresAtMs = Date.now() + LINK_TTL_MS;
  await putTelegramLinkCode(ownerId, codeHash(code), expiresAtMs);
  return { url: `https://t.me/${setting("TELEGRAM_BOT_USERNAME")}?start=${code}`, expires_at_ms: expiresAtMs };
}

async function telegramApi(method: string, payload: Record<string, unknown>): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${setting("TELEGRAM_BOT_TOKEN")}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json().catch(() => null) as { ok?: unknown; description?: unknown } | null;
  if (!response.ok || result?.ok !== true) throw new Error(`Telegram API rejected ${method}${typeof result?.description === "string" ? `: ${result.description}` : "."}`);
}

function telegramDelivery(): "webhook" | "polling" {
  return setting("TELEGRAM_DELIVERY") === "polling" ? "polling" : "webhook";
}

async function ensureTelegramWebhook(): Promise<void> {
  const webhookUrl = new URL("/api/telegram/webhook", setting("DONADS_PUBLIC_APP_URL")).toString();
  await telegramApi("setWebhook", {
    url: webhookUrl,
    secret_token: setting("TELEGRAM_WEBHOOK_SECRET"),
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  });
}

function taskUrl(taskId: string): string {
  const appUrl = new URL(setting("DONADS_PUBLIC_APP_URL"));
  appUrl.searchParams.set("task", taskId);
  return appUrl.toString();
}

type CallbackQuery = {
  id?: unknown;
  data?: unknown;
  from?: { id?: unknown };
  message?: { message_id?: unknown; chat?: { id?: unknown; type?: unknown } };
};

async function handleCallbackQuery(query: CallbackQuery): Promise<void> {
  const queryId = typeof query.id === "string" ? query.id : "";
  if (!queryId) return;
  const answer = (text: string) => telegramApi("answerCallbackQuery", { callback_query_id: queryId, text, show_alert: true });
  const chatId = String(query.message?.chat?.id ?? "");
  // Decisions are only accepted in the private chat that was linked to the wallet.
  if (!chatId || query.message?.chat?.type !== "private" || String(query.from?.id ?? "") !== chatId) return answer("Approvals only work in your private DONADS chat.");
  if (!await takeRateLimit(`telegram:${chatId}`, 12, 60_000)) return answer("Too many requests. Try again in a minute.");
  const offerDecision = parseOfferDecision(query.data);
  if (offerDecision) {
    const offerOwner = await getTelegramOwner(chatId);
    if (!offerOwner) return answer("This chat is not connected to a DONADS wallet.");
    const offerId = await decideOfferProposal(offerOwner, offerDecision.proposal_id, offerDecision.decision);
    const offer = offerId ? findOffer(offerId) : null;
    if (!offer) return answer("This offer was already handled or has expired.");
    const messageId = Number(query.message?.message_id);
    if (Number.isSafeInteger(messageId)) await telegramApi("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
    if (offerDecision.decision === "skip") {
      await answer("Skipped. Nothing was created.");
      await telegramApi("sendMessage", { chat_id: chatId, text: `Skipped ${offer.title} from ${offer.seller_name}. No escrow was created and no funds moved.` });
      return;
    }
    await answer("Go recorded. Confirm the escrow in your wallet.");
    await telegramApi("sendMessage", { chat_id: chatId, text: `Go recorded for ${offer.title} from ${offer.seller_name}. DONADS is preparing the ${offer.price_mon} MON escrow in your browser. Nothing moves until you sign it in your wallet.` });
    return;
  }
  const decision = parseFlowDecision(query.data);
  if (!decision) return answer("This button is no longer valid.");
  const ownerId = await getTelegramOwner(chatId);
  if (!ownerId) return answer("This chat is not connected to a DONADS wallet.");
  const task = await getTask(ownerId, decision.task_id);
  const stale = !task || task.bot !== "flow" || task.status.state !== "completed" || task.updated_at_ms.toString(36) !== decision.version;
  if (stale) return answer("This request changed or was already handled. Open DONADS for the current state.");
  const flowTask = task as FlowCompletedTask;
  const alreadyDecided = applyFlowDecision(flowTask, decision.action === "approve" ? { action: "approve", note: "Exact transfer approved in Telegram." } : { action: "reject", reason: "Rejected in Telegram." }, "telegram");
  if (alreadyDecided) return answer("This transfer was already handled.");
  await updateTask(flowTask);
  await answer(decision.action === "approve" ? "Approved. Sign the transaction in your wallet next." : "Rejected. No funds moved.");
  const messageId = Number(query.message?.message_id);
  if (Number.isSafeInteger(messageId)) {
    await telegramApi("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
  }
  if (decision.action === "reject") {
    await telegramApi("sendMessage", { chat_id: chatId, text: "Transfer rejected. No funds moved." });
    return;
  }
  await sendTelegramCheckpoint(flowTask);
}

export async function handleTelegramUpdate(update: unknown): Promise<void> {
  if (!telegramConfigured() || !update || typeof update !== "object") return;
  const envelope = update as { update_id?: unknown; message?: unknown; callback_query?: unknown };
  const updateId = Number(envelope.update_id);
  if (!Number.isSafeInteger(updateId) || updateId < 0 || !await claimTelegramUpdate(updateId)) return;
  if (envelope.callback_query && typeof envelope.callback_query === "object") {
    await handleCallbackQuery(envelope.callback_query as CallbackQuery);
    return;
  }
  const message = envelope.message;
  if (!message || typeof message !== "object") return;
  const item = message as { text?: unknown; chat?: { id?: unknown; type?: unknown; username?: unknown } };
  const chatId = String(item.chat?.id ?? "");
  if (!chatId || item.chat?.type !== "private" || typeof item.text !== "string") return;
  if (!await takeRateLimit(`telegram:${chatId}`, 12, 60_000)) return;
  const code = telegramStartCode(item.text);
  if (!code) {
    await telegramApi("sendMessage", { chat_id: chatId, text: "Open DONADS, connect your wallet, and choose Connect Telegram. This bot never signs transactions or asks for keys." });
    return;
  }
  const ownerId = await consumeTelegramLinkCode(codeHash(code), chatId, typeof item.chat?.username === "string" ? item.chat.username : null);
  await telegramApi("sendMessage", { chat_id: chatId, text: ownerId ? "DONADS is connected to your wallet. Transfer approvals will arrive here. Your wallet still signs every transaction." : "This link is invalid, expired, or already used. Create a new link inside DONADS." });
  if (ownerId) {
    // A user may connect Telegram after a checkpoint already exists.
    // Send a bounded backlog so no active approval is silently missed.
    const approvals = pendingApprovals(await listTasks(ownerId, 100)).slice(-10);
    await Promise.allSettled(approvals.map(async (approval) => {
      const task = await getTask(ownerId, approval.task_id);
      if (task) await sendTelegramCheckpoint(task);
    }));
  }
}

function checkpointMessage(task: Task, checkpoint: PendingApproval): { text: string; reply_markup: Record<string, unknown> } {
  const review = { text: "Open in DONADS", url: taskUrl(task.id) };
  if (task.bot === "flow" && checkpoint.kind === "intent_review") {
    return {
      text: flowReviewMessage(task as FlowCompletedTask),
      reply_markup: { inline_keyboard: [
        [{ text: "✅ Approve", callback_data: flowDecisionData("approve", task) }, { text: "❌ Reject", callback_data: flowDecisionData("reject", task) }],
        [review],
      ] },
    };
  }
  if (checkpoint.kind === "wallet_signature") {
    return {
      text: `DONADS: ${checkpoint.title}\n\n${checkpoint.summary}\n\nOpen DONADS on this phone and confirm in your wallet. Telegram cannot sign for you.`,
      reply_markup: { inline_keyboard: [[{ text: "Sign in wallet", url: taskUrl(task.id) }]] },
    };
  }
  return {
    text: `DONADS needs your attention\n\n${checkpoint.title}\n${checkpoint.summary}`,
    reply_markup: { inline_keyboard: [[review]] },
  };
}

export async function sendTelegramCheckpoint(task: Task): Promise<void> {
  if (!telegramConfigured()) return;
  const checkpoint = pendingApprovalForTask(task);
  if (!checkpoint) return;
  const link = await getTelegramLink(task.owner_id);
  if (!link) return;
  await telegramApi("sendMessage", { chat_id: link.chat_id, ...checkpointMessage(task, checkpoint) });
}

/** Sends a plain alert to the owner's linked chat, with an optional explorer link. */
export async function sendTelegramAlert(ownerId: string, text: string, link?: { label: string; url: string }): Promise<boolean> {
  if (!telegramConfigured()) return false;
  const chat = await getTelegramLink(ownerId);
  if (!chat) return false;
  await telegramApi("sendMessage", { chat_id: chat.chat_id, text, ...(link ? { reply_markup: { inline_keyboard: [[{ text: link.label, url: link.url }]] } } : {}) });
  return true;
}
