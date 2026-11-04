import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@/lib/donads-api";

const database = vi.hoisted(() => ({
  claimTelegramUpdate: vi.fn(async () => true),
  consumeTelegramLinkCode: vi.fn(async () => "0x1111111111111111111111111111111111111111"),
  getTask: vi.fn(async (): Promise<Task | null> => null),
  getTelegramLink: vi.fn(async () => ({ chat_id: "42", username: "alice", linked_at_ms: 1 })),
  listTasks: vi.fn(async (): Promise<Task[]> => []),
  putTelegramLinkCode: vi.fn(async () => undefined),
  takeRateLimit: vi.fn(async () => true),
}));

vi.mock("@/server/database", () => database);

import { createTelegramLink, handleTelegramUpdate } from "@/server/telegram";

const flowTask = {
  id: "00000000-0000-4000-8000-000000000001",
  owner_id: "0x1111111111111111111111111111111111111111",
  title: "Send 5 MON",
  prompt: "Send 5 MON",
  bot: "flow",
  input: {}, events: [], created_at_ms: 1, updated_at_ms: 2, feedback: null,
  status: { state: "completed", summary: "Prepared", latency_ms: 1, data: {
    agent_version: "test", execution_available: false, blocked_reason: "Approval required",
    workflow: {
      id: "workflow", title: "Transfer", purpose: "Test", payer: "0x1111111111111111111111111111111111111111",
      network: "Monad Testnet", chain_id: 10143, transfer_kind: "native", token: null, state: "awaiting_approval",
      payouts: [{ recipient_address: "0x2222222222222222222222222222222222222222", amount: "5", asset: "MON", token_contract: null }],
      totals: [{ asset: "MON", amount: "5" }], total_atomic: "5000000000000000000", approval_conditions: [], linked_task_id: null,
      approval: null, submission: null, submissions: [], execution: null, executions: [], audit_history: [],
    },
  } },
} as unknown as Task;

describe("Telegram activation and backlog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = "123456:test-token";
    process.env.TELEGRAM_BOT_USERNAME = "donads_bot";
    process.env.TELEGRAM_WEBHOOK_SECRET = "s".repeat(32);
    process.env.DONADS_PUBLIC_APP_URL = "https://donads.vercel.app";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, result: true }) })));
  });

  it("registers the authenticated webhook before creating a link", async () => {
    await expect(createTelegramLink("0xowner")).resolves.toMatchObject({ url: expect.stringContaining("https://t.me/donads_bot?start=dn_") });
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/setWebhook"), expect.objectContaining({ method: "POST" }));
    const payload = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(payload).toMatchObject({ url: "https://donads.vercel.app/api/telegram/webhook", secret_token: "s".repeat(32), allowed_updates: ["message", "callback_query"] });
    expect(database.putTelegramLinkCode).toHaveBeenCalledOnce();
  });

  it("sends existing pending transaction approvals after linking", async () => {
    database.listTasks.mockResolvedValueOnce([flowTask]);
    database.getTask.mockResolvedValueOnce(flowTask);
    await handleTelegramUpdate({ update_id: 7, message: { text: "/start dn_abcdefghijklmnop", chat: { id: 42, type: "private", username: "alice" } } });
    const bodies = vi.mocked(fetch).mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)));
    const review = bodies.find((body) => body.text?.includes("approve this exact transfer"));
    expect(review).toBeDefined();
    expect(review.text).toContain("0x2222222222222222222222222222222222222222");
    expect(review.reply_markup.inline_keyboard[0].map((button: { text: string }) => button.text)).toEqual(["✅ Approve", "❌ Reject"]);
  });
});
