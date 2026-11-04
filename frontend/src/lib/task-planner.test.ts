import { describe, expect, it } from "vitest";
import { planUnifiedTask } from "./task-planner";

describe("planUnifiedTask", () => {
  it("coordinates research and growth for sourced campaigns", () => {
    expect(planUnifiedTask("Research https://example.com and create a launch campaign").kind).toBe("operator");
  });
  it("routes Monad developer questions to official primary sources", () => {
    const plan = planUnifiedTask("How does the Monad JSON-RPC API handle transaction receipts?");
    expect(plan).toMatchObject({ kind: "scout" });
    if (plan.kind !== "scout") throw new Error("Expected Scout plan");
    expect(plan.prompt).toContain("https://docs.monad.xyz/reference/json-rpc/api");
    expect(plan.prompt).toContain("official Monad developer sources");
  });
  it("routes EVM bytecode scans to Sentinel", () => {
    expect(planUnifiedTask("Scan this contract bytecode 0x6000ff")).toEqual({ kind: "sentinel", bytecode: "0x6000ff" });
  });
  it("asks for purchase details instead of claiming execution", () => {
    expect(planUnifiedTask("Buy me headphones")).toMatchObject({ kind: "clarify" });
  });
  it("creates an exact deterministic MON transfer plan", () => {
    expect(planUnifiedTask("Send 0.25 MON to 0x2222222222222222222222222222222222222222 for testing")).toEqual({
      kind: "flow",
      recipient: "0x2222222222222222222222222222222222222222",
      amount: "0.25",
      purpose: "Send 0.25 MON to 0x2222222222222222222222222222222222222222 for testing",
      asset: "MON",
      tokenContract: null,
    });
  });
  it.each(["MON", "mons", "monads", "monts"])("normalizes the native asset alias %s", (asset) => {
    expect(planUnifiedTask(`Send 5 ${asset} to 0x1406Fe936D971A0dAE9a19DD3354b900B08Fa002`)).toMatchObject({
      kind: "flow",
      recipient: "0x1406Fe936D971A0dAE9a19DD3354b900B08Fa002",
      amount: "5",
      asset: "MON",
      tokenContract: null,
    });
  });
  it("accepts recipient-first native transfer wording", () => {
    expect(planUnifiedTask("0x1406Fe936D971A0dAE9a19DD3354b900B08Fa002 send 10 monads")).toMatchObject({
      kind: "flow", amount: "10", asset: "MON", recipient: "0x1406Fe936D971A0dAE9a19DD3354b900B08Fa002",
    });
  });
  it("creates an exact deterministic ERC-20 transfer plan", () => {
    expect(planUnifiedTask("Send 12.5 USDC token 0x1111111111111111111111111111111111111111 to 0x2222222222222222222222222222222222222222")).toEqual({
      kind: "flow", amount: "12.5", asset: "USDC", tokenContract: "0x1111111111111111111111111111111111111111",
      recipient: "0x2222222222222222222222222222222222222222",
      purpose: "Send 12.5 USDC token 0x1111111111111111111111111111111111111111 to 0x2222222222222222222222222222222222222222",
    });
  });
  it("asks for missing transfer fields", () => {
    expect(planUnifiedTask("Send MON to my friend")).toMatchObject({ kind: "clarify" });
  });
  it("creates an explicit same-amount MON batch", () => {
    expect(planUnifiedTask("Send 0.01 MON to each of 0x1111111111111111111111111111111111111111, 0x2222222222222222222222222222222222222222")).toEqual({
      kind: "flow_batch", amountEach: "0.01", recipients: ["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222"],
      purpose: "Send 0.01 MON to each of 0x1111111111111111111111111111111111111111, 0x2222222222222222222222222222222222222222",
    });
  });
  it("refuses an ambiguous multi-recipient amount", () => {
    expect(planUnifiedTask("Send 1 MON to 0x1111111111111111111111111111111111111111 and 0x2222222222222222222222222222222222222222")).toMatchObject({ kind: "clarify", message: expect.stringMatching(/per-recipient/i) });
  });
  it("requires explicit token contracts for a swap", () => {
    expect(planUnifiedTask("Swap 1 MON for USDC")).toMatchObject({ kind: "clarify", message: expect.stringMatching(/0xINPUT/i) });
  });
  it("builds a deterministic Uniswap quote request", () => {
    expect(planUnifiedTask("Swap 1 USDC token 0x1111111111111111111111111111111111111111 for DAI token 0x2222222222222222222222222222222222222222 max 0.5% slippage")).toMatchObject({
      kind: "swap", amount: "1", inputAsset: "USDC", outputAsset: "DAI", slippageBps: 50, maxPriceImpactBps: 200,
    });
  });

  it("routes policy-vault deployment and bounded session permissions deterministically", () => {
    expect(planUnifiedTask("Deploy my policy vault")).toEqual({ kind: "vault_deploy" });
    expect(planUnifiedTask("Allow session 0x1111111111111111111111111111111111111111 on vault 0x2222222222222222222222222222222222222222 to send up to 0.1 MON per transaction and 1 MON per day for 24 hours to 0x3333333333333333333333333333333333333333")).toEqual({
      kind: "session_configure", sessionKey: "0x1111111111111111111111111111111111111111", vault: "0x2222222222222222222222222222222222222222", perTransaction: "0.1", daily: "1", durationHours: 24, recipient: "0x3333333333333333333333333333333333333333",
    });
  });

  it("routes funded P2P escrow creation with explicit parties and terms", () => {
    expect(planUnifiedTask("Create escrow 1 MON for 0x1111111111111111111111111111111111111111 with arbiter 0x2222222222222222222222222222222222222222 refund after 24 hours terms Product delivered as agreed")).toEqual({
      kind: "escrow_create", amount: "1", seller: "0x1111111111111111111111111111111111111111", arbiter: "0x2222222222222222222222222222222222222222", refundHours: 24, terms: "Product delivered as agreed",
    });
  });

  it("routes P2P escrow lifecycle actions", () => {
    expect(planUnifiedTask("Release escrow 0x1111111111111111111111111111111111111111")).toEqual({ kind: "escrow_action", escrow: "0x1111111111111111111111111111111111111111", action: "release", evidence: null });
    expect(planUnifiedTask("Dispute escrow 0x1111111111111111111111111111111111111111 evidence Package was not delivered")).toEqual({ kind: "escrow_action", escrow: "0x1111111111111111111111111111111111111111", action: "dispute", evidence: "Package was not delivered" });
    expect(planUnifiedTask("Resolve escrow 0x1111111111111111111111111111111111111111 to seller resolution Delivery evidence accepted")).toEqual({ kind: "escrow_action", escrow: "0x1111111111111111111111111111111111111111", action: "resolve_seller", evidence: "Delivery evidence accepted" });
  });

  it("coordinates deliverable verification before preparing an escrow action", () => {
    expect(planUnifiedTask("Verify escrow 0x1111111111111111111111111111111111111111 with deliverable https://docs.monad.xyz")).toEqual({
      kind: "escrow_verify",
      escrow: "0x1111111111111111111111111111111111111111",
      deliverableUrl: "https://docs.monad.xyz",
    });
  });
});
