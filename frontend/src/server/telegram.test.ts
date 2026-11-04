import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FlowCompletedTask, Task } from "@/lib/donads-api";

const db = vi.hoisted(() => ({
  claimTelegramUpdate: vi.fn(async () => true),
  takeRateLimit: vi.fn(async () => true),
  getTelegramOwner: vi.fn(async (): Promise<string | null> => "0xowner"),
  getTelegramLink: vi.fn(async () => ({ chat_id: "42", username: "owner", linked_at_ms: 1 })),
  getTask: vi.fn(async (): Promise<Task | null> => null),
  updateTask: vi.fn(async () => undefined),
  consumeTelegramLinkCode: vi.fn(async () => null),
  putTelegramLinkCode: vi.fn(async () => undefined),
  listTasks: vi.fn(async (): Promise<Task[]> => []),
  decideOfferProposal: vi.fn(async (): Promise<string | null> => null),
}));
vi.mock("@/server/database", () => db);

import { offerDecisionData, parseOfferDecision, sendTelegramOffer } from "@/server/telegram";
import { rankOffers } from "@/lib/offers";
import { flowDecisionData, flowReviewMessage, handleTelegramUpdate, parseFlowDecision, telegramConfigured, telegramStartCode, telegramWebhookAuthorized } from "@/server/telegram";

const TASK_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const original = { ...process.env };

function configure() {
  process.env.TELEGRAM_BOT_TOKEN = "123456:token";
  process.env.TELEGRAM_BOT_USERNAME = "donads_bot";
  process.env.TELEGRAM_WEBHOOK_SECRET = "s".repeat(32);
  process.env.DONADS_PUBLIC_APP_URL = "https://donads.example";
}

function flowTask(state: FlowCompletedTask["status"]["data"]["workflow"]["state"] = "awaiting_approval"): FlowCompletedTask {
  return {
    id: TASK_ID, owner_id: "0xowner", prompt: "Send MON", bot: "flow", input: {}, events: [],
    created_at_ms: 1_700_000_000_000, updated_at_ms: 1_700_000_000_000, feedback: null,
    status: {
      state: "completed", summary: "Prepared", latency_ms: 1,
      data: {
        agent_version: "test", execution_available: false, blocked_reason: "",
        workflow: {
          id: "w", title: "Transfer", purpose: "Test", payer: "0x2222222222222222222222222222222222222222", network: "Monad Testnet", chain_id: 10143, state,
          payouts: [{ recipient_name: "Ana", recipient_address: RECIPIENT, asset: "MON", amount: "0.5", milestone: "t", deadline: null }],
          totals: [{ asset: "MON", amount: "0.5" }], approval_conditions: [], linked_task_id: null,
          approval: null, submission: null, execution: null, audit_history: [],
        },
      },
    },
  };
}

function tap(data: string, chatId = 42, fromId = chatId, type = "private") {
  return { update_id: 7, callback_query: { id: "q1", data, from: { id: fromId }, message: { message_id: 9, chat: { id: chatId, type } } } };
}

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));
function telegramCalls(): Array<{ method: string; payload: Record<string, unknown> }> {
  return fetchMock.mock.calls.map(([url, init]) => ({
    method: String(url).split("/").at(-1)!,
    payload: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>,
  }));
}

beforeEach(() => { vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { process.env = { ...original }; vi.unstubAllGlobals(); fetchMock.mockClear(); vi.clearAllMocks(); });

describe("Telegram connector security", () => {
  it("accepts only bounded start-link commands", () => {
    expect(telegramStartCode("/start dn_abcdefghijklmnop")).toBe("dn_abcdefghijklmnop");
    expect(telegramStartCode("approve 1 MON")).toBeNull();
    expect(telegramStartCode("/start https://evil.example")).toBeNull();
  });

  it("requires a constant-time matching webhook secret", () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "x".repeat(32);
    expect(telegramWebhookAuthorized("x".repeat(32))).toBe(true);
    expect(telegramWebhookAuthorized("y".repeat(32))).toBe(false);
    expect(telegramWebhookAuthorized(null)).toBe(false);
  });

  it("stays disabled until every server-side setting is valid", () => {
    configure();
    expect(telegramConfigured()).toBe(true);
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    expect(telegramConfigured()).toBe(false);
  });
});

describe("Telegram transfer approvals", () => {
  it("encodes decisions within Telegram's 64-byte callback limit and parses only that shape", () => {
    const data = flowDecisionData("approve", flowTask());
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(parseFlowDecision(data)).toEqual({ action: "approve", task_id: TASK_ID, version: (1_700_000_000_000).toString(36) });
    expect(parseFlowDecision(flowDecisionData("reject", flowTask()))?.action).toBe("reject");
    expect(parseFlowDecision(`fa:${TASK_ID}`)).toBeNull();
    expect(parseFlowDecision(`fa:not-a-task:abc`)).toBeNull();
    expect(parseFlowDecision(`send 1 MON to ${RECIPIENT}`)).toBeNull();
  });

  it("shows exact, unabbreviated values in the review message", () => {
    const text = flowReviewMessage(flowTask());
    expect(text).toContain(RECIPIENT);
    expect(text).toContain("0x2222222222222222222222222222222222222222");
    expect(text).toContain("0.5 MON");
    expect(text).toContain("Monad Testnet (chain 10143)");
    expect(text).toContain("wallet must still sign");
  });

  it("approves from the linked private chat and then asks for the wallet signature", async () => {
    configure();
    const task = flowTask();
    db.getTask.mockResolvedValueOnce(task);
    await handleTelegramUpdate(tap(flowDecisionData("approve", task)));
    expect(db.getTelegramOwner).toHaveBeenCalledWith("42");
    expect(db.getTask).toHaveBeenCalledWith("0xowner", TASK_ID);
    expect(db.updateTask).toHaveBeenCalledOnce();
    expect(task.status.data.workflow.state).toBe("authorized");
    const calls = telegramCalls();
    expect(calls.map((call) => call.method)).toEqual(["answerCallbackQuery", "editMessageReplyMarkup", "sendMessage"]);
    expect(String(calls[2].payload.text)).toContain("Wallet signature required");
    expect(JSON.stringify(calls[2].payload.reply_markup)).toContain("Sign in wallet");
  });

  it("rejects without moving funds", async () => {
    configure();
    const task = flowTask();
    db.getTask.mockResolvedValueOnce(task);
    await handleTelegramUpdate(tap(flowDecisionData("reject", task)));
    expect(task.status.data.workflow.state).toBe("rejected");
    expect(telegramCalls().at(-1)?.payload.text).toBe("Transfer rejected. No funds moved.");
  });

  it("ignores a stale button after the intent changed", async () => {
    configure();
    const task = flowTask();
    const data = flowDecisionData("approve", task);
    task.updated_at_ms += 1;
    db.getTask.mockResolvedValueOnce(task);
    await handleTelegramUpdate(tap(data));
    expect(db.updateTask).not.toHaveBeenCalled();
    expect(task.status.data.workflow.state).toBe("awaiting_approval");
    expect(String(telegramCalls()[0].payload.text)).toContain("changed or was already handled");
  });

  it("refuses taps from group chats or other users without touching tasks", async () => {
    configure();
    await handleTelegramUpdate(tap(flowDecisionData("approve", flowTask()), -100, 42, "group"));
    await handleTelegramUpdate(tap(flowDecisionData("approve", flowTask()), 42, 99));
    expect(db.getTelegramOwner).not.toHaveBeenCalled();
    expect(db.getTask).not.toHaveBeenCalled();
    expect(db.updateTask).not.toHaveBeenCalled();
  });

  it("refuses chats that are not linked to a wallet", async () => {
    configure();
    db.getTelegramOwner.mockResolvedValueOnce(null);
    await handleTelegramUpdate(tap(flowDecisionData("approve", flowTask())));
    expect(db.getTask).not.toHaveBeenCalled();
    expect(db.updateTask).not.toHaveBeenCalled();
  });

  it("sends Approve and Reject buttons for a new transfer intent", async () => {
    configure();
    const { sendTelegramCheckpoint } = await import("@/server/telegram");
    await sendTelegramCheckpoint(flowTask());
    const [call] = telegramCalls();
    expect(call.method).toBe("sendMessage");
    expect(call.payload.chat_id).toBe("42");
    const markup = JSON.stringify(call.payload.reply_markup);
    expect(markup).toContain(flowDecisionData("approve", flowTask()));
    expect(markup).toContain(flowDecisionData("reject", flowTask()));
  });
});

describe("Telegram offer proposals", () => {
  const PROPOSAL = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";

  it("encodes Go and Skip within the callback limit and parses only that shape", () => {
    expect(Buffer.byteLength(offerDecisionData("go", PROPOSAL))).toBeLessThanOrEqual(64);
    expect(parseOfferDecision(offerDecisionData("go", PROPOSAL))).toEqual({ decision: "go", proposal_id: PROPOSAL });
    expect(parseOfferDecision(offerDecisionData("skip", PROPOSAL))?.decision).toBe("skip");
    expect(parseOfferDecision("og:not-a-uuid")).toBeNull();
  });

  it("sends the ranked offer with exact seller wallet, price and Go/Skip buttons", async () => {
    configure();
    const [top] = rankOffers("logo design");
    await sendTelegramOffer("0xowner", PROPOSAL, top, 2);
    const [call] = telegramCalls();
    expect(call.method).toBe("sendMessage");
    expect(String(call.payload.text)).toContain(top.seller_address);
    expect(String(call.payload.text)).toContain(`${top.price_mon} MON`);
    expect(String(call.payload.text)).toContain("Test seller");
    expect(JSON.stringify(call.payload.reply_markup)).toContain(offerDecisionData("go", PROPOSAL));
  });

  it("refuses to send an offer when Telegram is not linked", async () => {
    configure();
    db.getTelegramLink.mockResolvedValueOnce(null as never);
    await expect(sendTelegramOffer("0xowner", PROPOSAL, rankOffers("logo design")[0], 2)).rejects.toThrow("Connect Telegram first");
  });

  it("records Go once and tells the user to sign in the wallet", async () => {
    configure();
    db.decideOfferProposal.mockResolvedValueOnce("logo-lumen");
    await handleTelegramUpdate(tap(offerDecisionData("go", PROPOSAL)));
    expect(db.decideOfferProposal).toHaveBeenCalledWith("0xowner", PROPOSAL, "go");
    const texts = telegramCalls().map((call) => String(call.payload.text ?? ""));
    expect(texts.some((text) => text.includes("Nothing moves until you sign"))).toBe(true);
  });

  it("records Skip and confirms nothing was created", async () => {
    configure();
    db.decideOfferProposal.mockResolvedValueOnce("logo-lumen");
    await handleTelegramUpdate(tap(offerDecisionData("skip", PROPOSAL)));
    expect(db.decideOfferProposal).toHaveBeenCalledWith("0xowner", PROPOSAL, "skip");
    expect(telegramCalls().at(-1)?.payload.text).toContain("No escrow was created");
  });

  it("refuses a repeated or foreign offer decision", async () => {
    configure();
    db.decideOfferProposal.mockResolvedValueOnce(null);
    await handleTelegramUpdate(tap(offerDecisionData("go", PROPOSAL)));
    expect(String(telegramCalls()[0].payload.text)).toContain("already handled");
  });
});
