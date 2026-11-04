import { afterEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@/lib/donads-api";

const db = vi.hoisted(() => ({
  listTelegramOwners: vi.fn(async (): Promise<string[]> => []),
  getWatchState: vi.fn(async (): Promise<{ last_block: number; seen_contracts: string[] } | null> => null),
  putWatchState: vi.fn(async () => undefined),
  listTasks: vi.fn(async (): Promise<Task[]> => []),
}));
vi.mock("@/server/database", () => db);
const rpc = vi.hoisted(() => ({ monadRpc: vi.fn<(method: string, params?: unknown[]) => Promise<unknown>>(async () => "0x0") }));
vi.mock("@/server/monad", () => rpc);
const tg = vi.hoisted(() => ({ sendTelegramAlert: vi.fn(async () => true) }));
vi.mock("@/server/telegram", () => tg);

import { lookalikeOf } from "@/lib/lookalike";
import { lookalikeProblem, paidRecipients } from "@/server/flow-guard";
import { addressTopic, alertMessage, classifyLogs, runWalletWatch, TOPICS, type RawLog } from "@/server/wallet-watcher";

const WALLET = "0x3333333333333333333333333333333333333333";
const TOKEN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SPENDER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MAX = `0x${"f".repeat(64)}`;

function log(overrides: Partial<RawLog>): RawLog {
  return { address: TOKEN, topics: [], data: "0x", transactionHash: `0x${"1".repeat(64)}`, blockNumber: "0x10", ...overrides };
}

afterEach(() => vi.clearAllMocks());

describe("wallet watch classification", () => {
  it("flags an unlimited ERC-20 approval from the wallet", () => {
    const alerts = classifyLogs(WALLET, [log({ topics: [TOPICS.approval, addressTopic(WALLET), addressTopic(SPENDER)], data: MAX })], new Set());
    expect(alerts).toEqual([expect.objectContaining({ kind: "unlimited_approval", token: TOKEN, spender: SPENDER, block: 16 })]);
  });

  it("ignores a bounded approval", () => {
    const bounded = `0x${(BigInt(10) ** BigInt(18)).toString(16).padStart(64, "0")}`;
    expect(classifyLogs(WALLET, [log({ topics: [TOPICS.approval, addressTopic(WALLET), addressTopic(SPENDER)], data: bounded })], new Set())).toEqual([]);
  });

  it("flags an approve-all NFT grant but not a revocation", () => {
    const grant = log({ topics: [TOPICS.approvalForAll, addressTopic(WALLET), addressTopic(SPENDER)], data: `0x${"0".repeat(63)}1` });
    const revoke = log({ topics: [TOPICS.approvalForAll, addressTopic(WALLET), addressTopic(SPENDER)], data: `0x${"0".repeat(64)}` });
    expect(classifyLogs(WALLET, [grant, revoke], new Set()).map((alert) => alert.kind)).toEqual(["approval_for_all"]);
  });

  it("flags a token or NFT from an unseen contract once, then remembers it", () => {
    const seen = new Set<string>();
    const nft = log({ topics: [TOPICS.transfer, addressTopic(SPENDER), addressTopic(WALLET), `0x${"0".repeat(63)}7`] });
    expect(classifyLogs(WALLET, [nft], seen)).toEqual([expect.objectContaining({ kind: "unknown_token_in", nft: true, contract: TOKEN })]);
    expect(classifyLogs(WALLET, [nft], seen)).toEqual([]);
  });

  it("writes alerts in plain words", () => {
    expect(alertMessage({ kind: "unlimited_approval", token: TOKEN, spender: SPENDER, transaction_hash: "0x1", block: 1 })).toContain("UNLIMITED permission");
    expect(alertMessage({ kind: "unknown_token_in", contract: TOKEN, from: SPENDER, nft: true, transaction_hash: "0x1", block: 1 })).toContain("phishing lure");
  });
});

describe("wallet watch run", () => {
  it("starts watching from the current block on first sight, without old alerts", async () => {
    rpc.monadRpc.mockResolvedValueOnce("0x64");
    db.listTelegramOwners.mockResolvedValueOnce([WALLET]);
    db.getWatchState.mockResolvedValueOnce(null);
    await runWalletWatch();
    expect(db.putWatchState).toHaveBeenCalledWith(WALLET, { last_block: 100, seen_contracts: [] });
    expect(tg.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it("scans new blocks in bounded windows and sends alerts with an explorer link", async () => {
    rpc.monadRpc.mockImplementation(async (method: string) => {
      if (method === "eth_blockNumber") return "0xc8";
      return [log({ topics: [TOPICS.approval, addressTopic(WALLET), addressTopic(SPENDER)], data: MAX, blockNumber: "0xa0" })];
    });
    db.listTelegramOwners.mockResolvedValueOnce([WALLET]);
    db.getWatchState.mockResolvedValueOnce({ last_block: 150, seen_contracts: [] });
    const summary = await runWalletWatch();
    expect(summary.scanned_blocks).toBe(50);
    expect(tg.sendTelegramAlert).toHaveBeenCalledWith(WALLET, expect.stringContaining("UNLIMITED"), expect.objectContaining({ url: expect.stringContaining("/tx/0x") }));
    expect(db.putWatchState).toHaveBeenCalledWith(WALLET, expect.objectContaining({ last_block: 200 }));
  });
});

describe("lookalike recipients", () => {
  const PAID = "0x1234aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5678";
  const POISON = "0x1234bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb5678";

  it("detects an address sharing the first and last characters", () => {
    expect(lookalikeOf(POISON, [PAID])).toBe(PAID);
    expect(lookalikeOf(PAID, [PAID])).toBeNull();
    expect(lookalikeOf("0x9999bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb5678", [PAID])).toBeNull();
  });

  it("only counts recipients that were actually paid or submitted", () => {
    const task = (state: string) => ({ bot: "flow", status: { state: "completed", data: { workflow: { state, payouts: [{ recipient_address: PAID }] } } } }) as unknown as Task;
    expect(paidRecipients([task("confirmed")]).has(PAID)).toBe(true);
    expect(paidRecipients([task("awaiting_approval")]).size).toBe(0);
  });

  it("stops a transfer to a lookalike with a clear reason", () => {
    expect(lookalikeProblem({ payouts: [{ recipient_address: POISON }] }, new Set([PAID]))).toContain("address-poisoning");
    expect(lookalikeProblem({ payouts: [{ recipient_address: PAID }] }, new Set([PAID]))).toBeNull();
  });
});
