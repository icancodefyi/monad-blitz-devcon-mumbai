import { describe, expect, it } from "vitest";

import { minimumOutput, priceImpactBps } from "@/server/uniswap";

describe("Uniswap policy math", () => {
  it("computes minimum output using integer basis points", () => {
    expect(minimumOutput(BigInt(1_000_000), 50)).toBe(BigInt(995_000));
  });

  it("computes explainable price impact against a small-size reference", () => {
    expect(priceImpactBps(BigInt(940), BigInt(10), BigInt(100), BigInt(1))).toBe(600);
    expect(priceImpactBps(BigInt(1_010), BigInt(10), BigInt(100), BigInt(1))).toBe(0);
  });
});
