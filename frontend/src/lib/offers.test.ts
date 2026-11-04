import { describe, expect, it } from "vitest";

import { DEMO_ARBITER, findOffer, matchCategory, offerEscrowCommand, rankOffers, TEST_OFFERS } from "@/lib/offers";
import { planUnifiedTask } from "@/lib/task-planner";

describe("best-offer ranking", () => {
  it("ranks by price, then delivery time, then completed deals", () => {
    const ranked = rankOffers("logo design");
    expect(ranked.map((offer) => offer.id)).toEqual(["logo-lumen", "logo-north", "logo-pixel"]);
    expect(ranked[0].reasons[0]).toBe("same price, faster delivery");
  });

  it("explains a lowest-price win", () => {
    const ranked = rankOffers("contract review");
    expect(ranked[0].id).toBe("review-north");
    expect(ranked[0].reasons[0]).toBe("lowest price");
  });

  it("breaks a full price and delivery tie by completed deals", () => {
    const ranked = rankOffers("translation", null, [
      { ...TEST_OFFERS[6], id: "a", completed_deals: 2 },
      { ...TEST_OFFERS[6], id: "b", completed_deals: 9 },
    ]);
    expect(ranked.map((offer) => offer.id)).toEqual(["b", "a"]);
    expect(ranked[0].reasons[0]).toBe("same price and delivery, more completed deals");
  });

  it("excludes offers above the budget", () => {
    expect(rankOffers("contract review", "0.2").map((offer) => offer.id)).toEqual(["review-north", "review-pixel"]);
    expect(rankOffers("logo design", "0.01")).toEqual([]);
  });

  it("labels every demo seller as a test seller", () => {
    expect(TEST_OFFERS.every((offer) => offer.test_seller && offer.seller_name.includes("test seller"))).toBe(true);
  });

  it("matches common wording to a category", () => {
    expect(matchCategory("a new logo")).toBe("logo design");
    expect(matchCategory("audit my solidity")).toBe("contract review");
    expect(matchCategory("translate our docs")).toBe("translation");
    expect(matchCategory("a pizza")).toBeNull();
  });
});

describe("offer chat commands", () => {
  it("routes a best-offer request with a budget", () => {
    expect(planUnifiedTask("Find the best offer for a logo design under 0.05 MON")).toEqual({ kind: "offer_search", item: "logo design", category: "logo design", maxMon: "0.05" });
  });

  it("explains supported categories for an unknown item", () => {
    expect(planUnifiedTask("Find the best offer for a pizza")).toMatchObject({ kind: "clarify" });
  });

  it("builds an exact escrow command for the accepted offer", () => {
    const offer = findOffer("logo-lumen")!;
    const plan = planUnifiedTask(offerEscrowCommand(offer));
    expect(plan).toMatchObject({ kind: "escrow_create", amount: "0.04", seller: offer.seller_address, arbiter: DEMO_ARBITER, refundHours: 24 });
    expect(plan.kind === "escrow_create" && plan.terms).toContain("Offer logo-lumen");
  });
});
