import { beforeEach, describe, expect, it } from "vitest";

import { forgetPendingFlowHash, readPendingFlowHash, rememberPendingFlowHash } from "./flow-submission";

describe("Flow submission recovery", () => {
  beforeEach(() => window.localStorage.clear());

  it("persists a wallet hash until receipt verification completes", () => {
    const hash = `0x${"ab".repeat(32)}`;
    rememberPendingFlowHash("task-1", hash.toUpperCase().replace("0X", "0x"));
    expect(readPendingFlowHash("task-1")).toBe(hash);
    forgetPendingFlowHash("task-1");
    expect(readPendingFlowHash("task-1")).toBeNull();
  });

  it("rejects malformed wallet hashes", () => {
    expect(() => rememberPendingFlowHash("task-1", "0x1234")).toThrow(/invalid transaction hash/i);
  });

  it("stores independent recovery hashes for each batch payout", () => {
    const first = `0x${"11".repeat(32)}`; const second = `0x${"22".repeat(32)}`;
    rememberPendingFlowHash("batch", first, 0); rememberPendingFlowHash("batch", second, 1);
    expect(readPendingFlowHash("batch", 0)).toBe(first);
    expect(readPendingFlowHash("batch", 1)).toBe(second);
    forgetPendingFlowHash("batch", 0);
    expect(readPendingFlowHash("batch", 1)).toBe(second);
  });
});
