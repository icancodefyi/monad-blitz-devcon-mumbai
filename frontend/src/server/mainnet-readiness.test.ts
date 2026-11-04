import { describe, expect, it } from "vitest";

import { mainnetReadiness } from "@/server/mainnet-readiness";

describe("mainnet readiness", () => {
  it("cannot enable mainnet from evidence flags alone", () => {
    const result = mainnetReadiness(100);
    expect(result.network_enabled).toBe(false);
    expect(result.total).toBe(20);
  });

  it("reports evidence progress without turning on execution", () => {
    const result = mainnetReadiness(10);
    expect(result.passed).toBeGreaterThanOrEqual(1);
    expect(result.network_enabled).toBe(false);
  });

  it("requires ten verified testnet receipts", () => {
    expect(mainnetReadiness(9).gates[0].passed).toBe(false);
    expect(mainnetReadiness(10).gates[0].passed).toBe(true);
  });
});
