// Best-offer finder. Offers are services priced in MON and settled through a
// DONADS escrow. Ranking is deterministic and explainable: the agent ranks and
// asks; the user decides in Telegram and signs in their wallet.
//
// The demo uses clearly labelled test sellers on Monad Testnet. Their wallets
// are controlled by the DONADS team so released test MON can be recovered.

export type Offer = {
  id: string;
  category: string;
  title: string;
  seller_name: string;
  seller_address: `0x${string}`;
  price_mon: string;
  delivery_hours: number;
  completed_deals: number;
  test_seller: true;
};

export type RankedOffer = Offer & { rank: number; reasons: string[] };

/** Escrow arbiter for demo offers: the DONADS testnet operations wallet. */
export const DEMO_ARBITER = "0x5f553d915DCE8db5edC32264B4b886664883D24B" as const;
export const DEMO_REFUND_HOURS = 24;

const SELLERS = {
  pixel: { seller_name: "Pixel Forge (test seller)", seller_address: "0xc17Eb9547f0c1CfF1F033C5bfe1B64bAe1e940Ae" },
  north: { seller_name: "North Studio (test seller)", seller_address: "0x61f74EdDB38E26211B05B5008F595F50Da85fbE7" },
  lumen: { seller_name: "Lumen Labs (test seller)", seller_address: "0xb90f3651089cE5f61360f6CCD675E765bb1c82Dc" },
} as const;

export const TEST_OFFERS: readonly Offer[] = [
  { id: "logo-pixel", category: "logo design", title: "Logo design, 3 concepts", ...SELLERS.pixel, price_mon: "0.05", delivery_hours: 48, completed_deals: 12, test_seller: true },
  { id: "logo-north", category: "logo design", title: "Logo design, 2 concepts", ...SELLERS.north, price_mon: "0.04", delivery_hours: 72, completed_deals: 3, test_seller: true },
  { id: "logo-lumen", category: "logo design", title: "Logo design, 2 concepts", ...SELLERS.lumen, price_mon: "0.04", delivery_hours: 24, completed_deals: 9, test_seller: true },
  { id: "review-pixel", category: "contract review", title: "Solidity contract review", ...SELLERS.pixel, price_mon: "0.2", delivery_hours: 72, completed_deals: 4, test_seller: true },
  { id: "review-north", category: "contract review", title: "Solidity contract review", ...SELLERS.north, price_mon: "0.15", delivery_hours: 96, completed_deals: 7, test_seller: true },
  { id: "review-lumen", category: "contract review", title: "Solidity contract review", ...SELLERS.lumen, price_mon: "0.25", delivery_hours: 48, completed_deals: 15, test_seller: true },
  { id: "translate-pixel", category: "translation", title: "Docs translation, 1,000 words", ...SELLERS.pixel, price_mon: "0.02", delivery_hours: 24, completed_deals: 20, test_seller: true },
  { id: "translate-north", category: "translation", title: "Docs translation, 1,000 words", ...SELLERS.north, price_mon: "0.03", delivery_hours: 12, completed_deals: 5, test_seller: true },
  { id: "translate-lumen", category: "translation", title: "Docs translation, 1,000 words", ...SELLERS.lumen, price_mon: "0.02", delivery_hours: 36, completed_deals: 2, test_seller: true },
];

const CATEGORY_WORDS: Record<string, RegExp> = {
  "logo design": /\b(?:logo|branding|brand mark|design)\b/i,
  "contract review": /\b(?:contract review|audit|solidity|smart contract|code review)\b/i,
  translation: /\b(?:translat\w*|localis\w*|localiz\w*)\b/i,
};

export function offerCategories(): string[] { return Object.keys(CATEGORY_WORDS); }

export function matchCategory(item: string): string | null {
  for (const [category, pattern] of Object.entries(CATEGORY_WORDS)) if (pattern.test(item)) return category;
  return null;
}

function toWei(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * BigInt(10) ** BigInt(18) + BigInt((fraction + "0".repeat(18)).slice(0, 18) || "0");
}

/**
 * Ranks offers for a category: lowest price first, then fastest delivery, then
 * most completed deals. Offers above the optional budget are excluded.
 */
export function rankOffers(category: string, maxMon?: string | null, offers: readonly Offer[] = TEST_OFFERS): RankedOffer[] {
  const budget = maxMon ? toWei(maxMon) : null;
  const candidates = offers.filter((offer) => offer.category === category && (budget === null || toWei(offer.price_mon) <= budget));
  const sorted = [...candidates].sort((left, right) => {
    const price = toWei(left.price_mon) - toWei(right.price_mon);
    if (price !== BigInt(0)) return price < BigInt(0) ? -1 : 1;
    if (left.delivery_hours !== right.delivery_hours) return left.delivery_hours - right.delivery_hours;
    return right.completed_deals - left.completed_deals;
  });
  return sorted.map((offer, index) => {
    const reasons = [`${offer.price_mon} MON`, `delivery within ${offer.delivery_hours}h`, `${offer.completed_deals} completed deals`];
    if (index === 0 && sorted[1]) {
      if (toWei(offer.price_mon) < toWei(sorted[1].price_mon)) reasons.unshift("lowest price");
      else if (offer.delivery_hours < sorted[1].delivery_hours) reasons.unshift("same price, faster delivery");
      else reasons.unshift("same price and delivery, more completed deals");
    }
    return { ...offer, rank: index + 1, reasons };
  });
}

export function findOffer(id: string): Offer | null {
  return TEST_OFFERS.find((offer) => offer.id === id) ?? null;
}

/** Exact escrow terms for an accepted offer; hashed into the escrow on-chain. */
export function offerEscrowTerms(offer: Offer): string {
  return `Offer ${offer.id}: ${offer.title} from ${offer.seller_name} for ${offer.price_mon} MON, delivered within ${offer.delivery_hours}h`;
}

/** The chat command that creates the escrow for an accepted offer. */
export function offerEscrowCommand(offer: Offer): string {
  return `Create escrow ${offer.price_mon} MON for ${offer.seller_address} with arbiter ${DEMO_ARBITER} refund after ${DEMO_REFUND_HOURS} hours terms ${offerEscrowTerms(offer)}`;
}
