// Order placement and matching. Matching is plain code over the demo market
// plus other wallets' open orders. A match is only a proposal: the owner taps
// Go in Telegram, and their wallet signs any on-chain step.

import { randomUUID } from "node:crypto";

import { bestMatch, DEMO_BOOK, MAX_OPEN_ORDERS, validateOrder, type BookOrder, type OrderInput } from "@/lib/orders";
import { insertOrder, insertOrderMatch, listOpenOrdersFromOthers, listOwnerOpenOrders, setOrderStatus, type OrderMatch } from "@/server/database";

export type PlacedOrder = { order_id: string; match: Omit<OrderMatch, "created_at_ms" | "decided_at_ms" | "decision"> | null; counterpart_match: Omit<OrderMatch, "created_at_ms" | "decided_at_ms" | "decision"> | null };

function bookFromStored(order: Awaited<ReturnType<typeof listOpenOrdersFromOthers>>[number]): BookOrder {
  return { id: order.order_id, side: order.side, amount: order.amount, price: order.price, name: `Wallet ${order.owner_id.slice(0, 6)}…${order.owner_id.slice(-4)}`, address: order.owner_id as `0x${string}`, demo: false, owner_id: order.owner_id };
}

/**
 * Stores the order and looks for a match. Real wallets' orders are tried
 * first (oldest first), then the labelled demo market. Both real parties get
 * their own match record so each can say Go or Skip.
 */
export async function placeOrder(ownerId: string, input: OrderInput): Promise<PlacedOrder> {
  const problem = validateOrder(input);
  if (problem) throw new Error(problem);
  if ((await listOwnerOpenOrders(ownerId)).length >= MAX_OPEN_ORDERS) throw new Error(`You already have ${MAX_OPEN_ORDERS} open orders. Cancel some first.`);

  const orderId = randomUUID();
  const opposite = input.side === "buy" ? "sell" : "buy";
  const real = (await listOpenOrdersFromOthers(ownerId, opposite)).map(bookFromStored);
  const found = bestMatch(input, real) ?? bestMatch(input, DEMO_BOOK);

  await insertOrder({ order_id: orderId, owner_id: ownerId, side: input.side, amount: input.amount, price: input.price, status: found ? "matched" : "open" });
  if (!found) return { order_id: orderId, match: null, counterpart_match: null };

  const match = { match_id: randomUUID(), owner_id: ownerId, side: input.side, amount: input.amount, price: found.price, counterparty_id: found.id, counterparty_name: found.name, counterparty_address: found.address, counterparty_demo: found.demo };
  await insertOrderMatch(match);

  let counterpartMatch: PlacedOrder["counterpart_match"] = null;
  if (!found.demo && found.owner_id) {
    await setOrderStatus(found.id, "matched");
    counterpartMatch = { match_id: randomUUID(), owner_id: found.owner_id, side: found.side, amount: input.amount, price: found.price, counterparty_id: orderId, counterparty_name: `Wallet ${ownerId.slice(0, 6)}…${ownerId.slice(-4)}`, counterparty_address: ownerId, counterparty_demo: false };
    await insertOrderMatch(counterpartMatch);
  }
  return { order_id: orderId, match, counterpart_match: counterpartMatch };
}
