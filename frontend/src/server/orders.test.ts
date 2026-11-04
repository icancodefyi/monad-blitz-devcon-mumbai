import { afterEach, describe, expect, it, vi } from "vitest";

import type { StoredOrder } from "@/server/database";

const db = vi.hoisted(() => ({
  insertOrder: vi.fn(async () => undefined),
  insertOrderMatch: vi.fn(async () => undefined),
  listOpenOrdersFromOthers: vi.fn(async (): Promise<StoredOrder[]> => []),
  listOwnerOpenOrders: vi.fn(async (): Promise<StoredOrder[]> => []),
  setOrderStatus: vi.fn(async () => undefined),
}));
vi.mock("@/server/database", () => db);

import { placeOrder } from "@/server/orders";

const ME = "0x3333333333333333333333333333333333333333";
const OTHER = "0x4444444444444444444444444444444444444444";
const stored = (overrides: Partial<StoredOrder>): StoredOrder => ({ order_id: "9f1c3a52-1111-4222-8333-444455556666", owner_id: OTHER, side: "buy", amount: "10", price: "0.6", status: "open", created_at_ms: 1, ...overrides });

afterEach(() => vi.clearAllMocks());

describe("placing an order", () => {
  it("matches the demo market when no other wallet has a crossing order", async () => {
    const placed = await placeOrder(ME, { side: "sell", amount: "10", price: "0.5" });
    expect(placed.match).toMatchObject({ owner_id: ME, side: "sell", counterparty_demo: true });
    expect(placed.counterpart_match).toBeNull();
    expect(db.insertOrder).toHaveBeenCalledWith(expect.objectContaining({ owner_id: ME, status: "matched" }));
  });

  it("prefers another real wallet and gives both sides their own match", async () => {
    db.listOpenOrdersFromOthers.mockResolvedValueOnce([stored({})]);
    const placed = await placeOrder(ME, { side: "sell", amount: "10", price: "0.5" });
    expect(placed.match).toMatchObject({ counterparty_demo: false, price: "0.6", counterparty_address: OTHER });
    expect(placed.counterpart_match).toMatchObject({ owner_id: OTHER, side: "buy", counterparty_address: ME });
    expect(db.setOrderStatus).toHaveBeenCalledWith("9f1c3a52-1111-4222-8333-444455556666", "matched");
    expect(db.insertOrderMatch).toHaveBeenCalledTimes(2);
  });

  it("leaves the order open when nothing crosses", async () => {
    const placed = await placeOrder(ME, { side: "buy", amount: "10", price: "0.01" });
    expect(placed.match).toBeNull();
    expect(db.insertOrder).toHaveBeenCalledWith(expect.objectContaining({ status: "open" }));
    expect(db.insertOrderMatch).not.toHaveBeenCalled();
  });

  it("rejects bad values and too many open orders", async () => {
    await expect(placeOrder(ME, { side: "buy", amount: "0", price: "1" })).rejects.toThrow("amount");
    db.listOwnerOpenOrders.mockResolvedValueOnce(Array.from({ length: 5 }, () => stored({ owner_id: ME })));
    await expect(placeOrder(ME, { side: "buy", amount: "1", price: "1" })).rejects.toThrow("open orders");
    expect(db.insertOrder).not.toHaveBeenCalled();
  });
});
