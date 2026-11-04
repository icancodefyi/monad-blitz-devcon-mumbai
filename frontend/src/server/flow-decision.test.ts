import { describe, expect, it } from "vitest";

import type { FlowCompletedTask } from "@/lib/donads-api";
import { applyFlowDecision } from "@/server/flow-decision";

function flowTask(state: FlowCompletedTask["status"]["data"]["workflow"]["state"] = "awaiting_approval"): FlowCompletedTask {
  return {
    id: "00000000-0000-4000-8000-000000000001", owner_id: "0xowner", prompt: "Send MON", bot: "flow", input: {}, events: [],
    created_at_ms: 1_000, updated_at_ms: 1_000, feedback: null,
    status: {
      state: "completed", summary: "Prepared", latency_ms: 1,
      data: {
        agent_version: "test", execution_available: false, blocked_reason: "",
        workflow: {
          id: "w", title: "Transfer", purpose: "Test", payer: "0xowner", network: "Monad Testnet", chain_id: 10143, state,
          payouts: [{ recipient_name: "Ana", recipient_address: "0x1111111111111111111111111111111111111111", asset: "MON", amount: "0.5", milestone: "t", deadline: null }],
          totals: [{ asset: "MON", amount: "0.5" }], approval_conditions: [], linked_task_id: null,
          approval: null, submission: null, execution: null, audit_history: [],
        },
      },
    },
  };
}

describe("applyFlowDecision", () => {
  it("authorizes only the intent and records the channel", () => {
    const task = flowTask();
    expect(applyFlowDecision(task, { action: "approve" }, "telegram", 2_000)).toBe(false);
    const workflow = task.status.data.workflow;
    expect(workflow.state).toBe("authorized");
    expect(workflow.approval).toMatchObject({ decision: "approved", decided_at_ms: 2_000 });
    expect(workflow.audit_history.at(-1)?.detail).toContain("via Telegram");
    expect(workflow.audit_history.at(-1)?.detail).toContain("wallet signature still required");
    expect(task.updated_at_ms).toBe(2_000);
    expect(task.events.at(-1)?.kind).toBe("approve");
  });

  it("rejects without moving funds", () => {
    const task = flowTask();
    expect(applyFlowDecision(task, { action: "reject" }, "web", 2_000)).toBe(false);
    expect(task.status.data.workflow.state).toBe("rejected");
    expect(task.status.summary).toContain("no funds moved");
  });

  it("refuses to change an intent that already left review", () => {
    for (const state of ["authorized", "submitted", "confirmed", "rejected"] as const) {
      const task = flowTask(state);
      expect(applyFlowDecision(task, { action: "approve" }, "telegram", 2_000)).toBe(true);
      expect(task.status.data.workflow.state).toBe(state);
      expect(task.updated_at_ms).toBe(1_000);
      expect(task.events).toEqual([]);
    }
  });
});
