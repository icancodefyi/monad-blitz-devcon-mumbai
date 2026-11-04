import { describe, expect, it } from "vitest";

import type { FlowCompletedTask, Task } from "@/lib/donads-api";
import { APPROVAL_REMINDER_AFTER_MS, pendingApprovals } from "@/lib/approvals";

function flowTask(state: "awaiting_approval" | "authorized" | "submitted" | "confirmed"): FlowCompletedTask {
  const now = 1_000_000;
  return {
    id: "flow-1", owner_id: "0xowner", prompt: "Send MON", bot: "flow", input: {}, events: [],
    created_at_ms: now, updated_at_ms: now, feedback: null,
    status: {
      state: "completed", summary: "Prepared", latency_ms: 12,
      data: {
        agent_version: "test", execution_available: false, blocked_reason: "",
        workflow: {
          id: "workflow-1", title: "Transfer", purpose: "Test", payer: "0xowner",
          network: "Monad Testnet", chain_id: 10143, state,
          payouts: [{ recipient_name: "Recipient", recipient_address: "0x1234567890abcdef", asset: "MON", amount: "1.5", milestone: "Test", deadline: null }],
          totals: [{ asset: "MON", amount: "1.5" }], approval_conditions: [], linked_task_id: null,
          approval: state === "authorized" ? { decision: "approved", note: "ok", decided_at_ms: now } : null,
          submission: state === "submitted" ? { transaction_hash: `0x${"a".repeat(64)}`, submitted_at_ms: now } : null,
          execution: null, audit_history: [],
        },
      },
    },
  };
}

describe("pendingApprovals", () => {
  it("derives actionable checkpoints without creating new approval state", () => {
    const approvals = pendingApprovals([
      flowTask("awaiting_approval"),
      { ...flowTask("confirmed"), id: "done" },
    ], 1_000_001);
    expect(approvals).toEqual([expect.objectContaining({
      task_id: "flow-1", kind: "intent_review", title: "Review MON transfer", reminder_due: false,
    })]);
  });

  it("marks an existing checkpoint for reminder only after the threshold", () => {
    const task = flowTask("authorized");
    expect(pendingApprovals([task], task.updated_at_ms + APPROVAL_REMINDER_AFTER_MS - 1)[0].reminder_due).toBe(false);
    expect(pendingApprovals([task], task.updated_at_ms + APPROVAL_REMINDER_AFTER_MS)[0]).toMatchObject({ kind: "wallet_signature", reminder_due: true });
  });

  it("ignores running, failed, rejected and confirmed tasks", () => {
    const running = { ...flowTask("awaiting_approval"), id: "running", status: { state: "running" as const } } as Task;
    const failed = { ...flowTask("awaiting_approval"), id: "failed", status: { state: "failed" as const, error: "no", latency_ms: 1 } } as Task;
    expect(pendingApprovals([flowTask("confirmed"), running, failed])).toEqual([]);
  });
});
