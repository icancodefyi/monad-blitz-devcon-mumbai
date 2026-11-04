// P2P orders for MON, priced in a test unit ("tUSD"). Matching is plain,
// deterministic code. DONADS matches and asks; nobody's money moves until
// both the Go tap and a wallet signature happen.
//
// The demo market contains clearly labelled test counterparties on Monad
// Testnet. "tUSD" is a display unit for the demo, not a real token.

import { DEMO_ARBITER, DEMO_REFUND_HOURS } from "@/lib/offers";

export type OrderSide = "buy" | "sell";

export type OrderInput = { side: OrderSide; amount: string; price: string };

export type BookOrder = {
  id: string;
  side: OrderSide;
  amount: string;
  price: string;
  name: string;
  address: `0x${string}`;
  demo: boolean;
  owner_id?: string;
};

export const PRICE_UNIT = "tUSD";
export const MAX_OPEN_ORDERS = 5;
export const MAX_AMOUNT_MON = "1000";

const ORDER_PATTERN = /^\/?(buy|sell)\s+(\d+(?:\.\d{1,18})?)\s*MON\s+(?:at|@|for)\s*(\d+(?:\.\d{1,18})?)(?:\s*(?:tUSD|usd|usdc))?\s*(?:each|per\s+MON)?\s*[.!]?$/i;

export function parseOrderCommand(text: string): OrderInput | null {
  const match = text.trim().match(ORDER_PATTERN);
  if (!match) return null;
  return { side: match[1].toLowerCase() as OrderSide, amount: match[2], price: match[3] };
}

const SCALE = BigInt(10) ** BigInt(18);

export function toUnits(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * SCALE + BigInt((fraction + "0".repeat(18)).slice(0, 18) || "0");
}

export function fromUnits(value: bigint): string {
  const whole = value / SCALE;
  const fraction = (value % SCALE).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function validateOrder(input: OrderInput): string | null {
  const amount = toUnits(input.amount);
  const price = toUnits(input.price);
  if (amount <= BigInt(0)) return "The amount must be greater than zero.";
  if (price <= BigInt(0)) return "The price must be greater than zero.";
  if (amount > toUnits(MAX_AMOUNT_MON)) return `The amount can be at most ${MAX_AMOUNT_MON} MON.`;
  return null;
}

/** Total in the price unit: amount (MON) times price per MON. */
export function tradeTotal(amount: string, price: string): string {
  return fromUnits((toUnits(amount) * toUnits(price)) / SCALE);
}

const DEMO_SELLER_1 = "0xc17Eb9547f0c1CfF1F033C5bfe1B64bAe1e940Ae" as const;
const DEMO_SELLER_2 = "0x61f74EdDB38E26211B05B5008F595F50Da85fbE7" as const;
const DEMO_BUYER = "0xb90f3651089cE5f61360f6CCD675E765bb1c82Dc" as const;

export const DEMO_BOOK: readonly BookOrder[] = [
  { id: "demo-sell-1", side: "sell", amount: "10", price: "0.48", name: "Demo seller Aria (test wallet)", address: DEMO_SELLER_1, demo: true },
  { id: "demo-sell-2", side: "sell", amount: "25", price: "0.52", name: "Demo seller Kai (test wallet)", address: DEMO_SELLER_2, demo: true },
  { id: "demo-buy-1", side: "buy", amount: "10", price: "0.55", name: "Demo buyer Mira (test wallet)", address: DEMO_BUYER, demo: true },
  { id: "demo-buy-2", side: "buy", amount: "50", price: "0.50", name: "Demo buyer Noor (test wallet)", address: DEMO_SELLER_2, demo: true },
];

/**
 * Best opposite order that crosses the user's price and can fill the amount.
 * A buyer gets the lowest sell price; a seller gets the highest buy price.
 * Ties go to the earliest order in the list.
 */
export function bestMatch(order: OrderInput, candidates: readonly BookOrder[]): BookOrder | null {
  const wanted = toUnits(order.amount);
  const limit = toUnits(order.price);
  let best: BookOrder | null = null;
  for (const candidate of candidates) {
    if (candidate.side === order.side) continue;
    if (toUnits(candidate.amount) < wanted) continue;
    const price = toUnits(candidate.price);
    if (order.side === "buy" ? price > limit : price < limit) continue;
    if (!best) { best = candidate; continue; }
    const bestPrice = toUnits(best.price);
    if (order.side === "buy" ? price < bestPrice : price > bestPrice) best = candidate;
  }
  return best;
}

/** The trade settles at the resting order's price. */
export function tradeTerms(order: OrderInput, counterparty: BookOrder, matchId: string): string {
  const mon = order.side === "sell" ? "sold by you" : "bought by you";
  return `Trade ${matchId.slice(0, 8)}: ${order.amount} MON ${mon} at ${counterparty.price} ${PRICE_UNIT} each (total ${tradeTotal(order.amount, counterparty.price)} ${PRICE_UNIT}) with ${counterparty.name}`;
}

/** Chat command that locks the seller's MON in escrow for the buyer. */
export function sellerEscrowCommand(order: OrderInput, counterparty: BookOrder, matchId: string): string {
  return `Create escrow ${order.amount} MON for ${counterparty.address} with arbiter ${DEMO_ARBITER} refund after ${DEMO_REFUND_HOURS} hours terms ${tradeTerms(order, counterparty, matchId)}`;
}
