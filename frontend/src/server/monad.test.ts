import { describe, expect, it } from "vitest";

import { encodeErc20Transfer, formatTokenAmount, tokenAmountToAtomic } from "@/server/monad";

describe("Monad ERC-20 helpers", () => {
  it("converts exact token decimals without floating point", () => {
    expect(tokenAmountToAtomic("12.345678", 6)).toBe(BigInt("12345678"));
    expect(formatTokenAmount(BigInt("12345678"), 6)).toBe("12.345678");
  });

  it("rejects precision beyond the token contract decimals", () => {
    expect(() => tokenAmountToAtomic("1.0000001", 6)).toThrow(/at most 6/i);
  });

  it("encodes the exact ERC-20 transfer selector, recipient and amount", () => {
    const data = encodeErc20Transfer("0x2222222222222222222222222222222222222222", BigInt(25));
    expect(data).toBe(`0xa9059cbb${"0".repeat(24)}2222222222222222222222222222222222222222${"0".repeat(62)}19`);
  });
});
