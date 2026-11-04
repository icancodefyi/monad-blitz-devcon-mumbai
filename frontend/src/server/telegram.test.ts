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
}));
vi.mock("@/server/database", () => db);

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

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response("{}", { status: 200 }));
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
