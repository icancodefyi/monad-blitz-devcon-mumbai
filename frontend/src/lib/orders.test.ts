import { describe, expect, it } from "vitest";

import { bestMatch, DEMO_BOOK, fromUnits, parseOrderCommand, sellerEscrowCommand, toUnits, tradeTotal, validateOrder, type BookOrder } from "@/lib/orders";
import { planUnifiedTask } from "@/lib/task-planner";

describe("order commands", () => {
  it.each([
    ["/sell 10 MON at 0.5", { side: "sell", amount: "10", price: "0.5" }],
    ["/buy 2.5 MON @ 0.48", { side: "buy", amount: "2.5", price: "0.48" }],
    ["Sell 10 MON for 0.5 tUSD each", { side: "sell", amount: "10", price: "0.5" }],
    ["buy 1 mon at 1 usd per MON", { side: "buy", amount: "1", price: "1" }],
  ])("parses %s", (text, expected) => {
    expect(parseOrderCommand(text)).toEqual(expected);
  });

  it.each(["send 10 MON to 0x1111111111111111111111111111111111111111", "buy a pizza", "/sell MON at 0.5", "sell 10 MON at"])("ignores %s", (text) => {
    expect(parseOrderCommand(text)).toBeNull();
  });

  it("routes chat orders to the planner as an order, not a transfer", () => {
    expect(planUnifiedTask("Sell 10 MON at 0.5")).toEqual({ kind: "order_place", side: "sell", amount: "10", price: "0.5" });
    expect(planUnifiedTask("Cancel my orders")).toEqual({ kind: "order_cancel" });
  });

  it("validates amounts and prices", () => {
    expect(validateOrder({ side: "buy", amount: "0", price: "1" })).toContain("amount");
    expect(validateOrder({ side: "buy", amount: "1", price: "0" })).toContain("price");
    expect(validateOrder({ side: "buy", amount: "1001", price: "1" })).toContain("at most");
    expect(validateOrder({ side: "sell", amount: "10", price: "0.5" })).toBeNull();
  });
});

describe("exact decimal math", () => {
  it("converts without floating point error", () => {
    expect(fromUnits(toUnits("0.1") + toUnits("0.2"))).toBe("0.3");
    expect(tradeTotal("10", "0.48")).toBe("4.8");
    expect(tradeTotal("2.5", "0.4")).toBe("1");
  });
});

describe("matching", () => {
  const order = (id: string, side: "buy" | "sell", amount: string, price: string): BookOrder => ({ id, side, amount, price, name: id, address: "0x1111111111111111111111111111111111111111", demo: true });

  it("a buyer gets the lowest sell price at or under their limit", () => {
    const book = [order("a", "sell", "10", "0.52"), order("b", "sell", "10", "0.48"), order("c", "sell", "10", "0.6")];
    expect(bestMatch({ side: "buy", amount: "10", price: "0.55" }, book)?.id).toBe("b");
  });

  it("a seller gets the highest buy price at or over their limit", () => {
    const book = [order("a", "buy", "10", "0.5"), order("b", "buy", "10", "0.55"), order("c", "buy", "10", "0.4")];
    expect(bestMatch({ side: "sell", amount: "10", price: "0.45" }, book)?.id).toBe("b");
  });

  it("does not match when prices do not cross, the side is the same, or the order is too small", () => {
    expect(bestMatch({ side: "buy", amount: "10", price: "0.4" }, [order("a", "sell", "10", "0.5")])).toBeNull();
    expect(bestMatch({ side: "buy", amount: "10", price: "0.9" }, [order("a", "buy", "10", "0.5")])).toBeNull();
    expect(bestMatch({ side: "buy", amount: "10", price: "0.9" }, [order("a", "sell", "5", "0.5")])).toBeNull();
  });

  it("an earlier order wins an exact price tie", () => {
    const book = [order("first", "sell", "10", "0.5"), order("second", "sell", "10", "0.5")];
    expect(bestMatch({ side: "buy", amount: "10", price: "0.5" }, book)?.id).toBe("first");
  });

  it("the demo market can fill the example from the pitch", () => {
    expect(bestMatch({ side: "sell", amount: "10", price: "0.5" }, DEMO_BOOK)?.name).toContain("Demo buyer");
    expect(bestMatch({ side: "buy", amount: "10", price: "0.5" }, DEMO_BOOK)?.name).toContain("Demo seller");
  });

  it("builds an exact escrow command for the seller that the planner accepts", () => {
    const counterparty = DEMO_BOOK.find((candidate) => candidate.id === "demo-buy-1")!;
    const plan = planUnifiedTask(sellerEscrowCommand({ side: "sell", amount: "10", price: "0.5" }, counterparty, "1b4e28ba-2fa1-41d2-883f-0016d3cca427"));
    expect(plan).toMatchObject({ kind: "escrow_create", amount: "10", seller: counterparty.address, refundHours: 24 });
    expect(plan.kind === "escrow_create" && plan.terms).toContain("Trade 1b4e28ba");
  });
});
