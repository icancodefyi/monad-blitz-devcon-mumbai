import { describe, expect, it } from "vitest";

import type { Task } from "@/lib/donads-api";
import { missionStateForTask, transactionIntentForTask, transactionIntentsForTask } from "@/lib/missions";

function flowTask(state: "awaiting_approval" | "authorized" | "submitted" | "confirmed" | "rejected"): Task {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    owner_id: "0x1111111111111111111111111111111111111111",
    prompt: "Send 1 MON",
    bot: "flow",
    input: {}, events: [], created_at_ms: 1, updated_at_ms: 1, feedback: null,
    status: {
      state: "completed", summary: "Prepared", latency_ms: 1,
      data: {
        agent_version: "test", execution_available: false, blocked_reason: "",
        workflow: {
          id: "00000000-0000-4000-8000-000000000002", title: "Transfer", purpose: "Test",
          payer: "0x1111111111111111111111111111111111111111", network: "Monad Testnet", chain_id: 10143,
          transfer_kind: "native", token: null, state,
          payouts: [{ recipient_name: "Recipient", recipient_address: "0x2222222222222222222222222222222222222222", asset: "MON", amount: "1", milestone: "Test", deadline: null }],
          totals: [{ asset: "MON", amount: "1" }], approval_conditions: [], linked_task_id: null,
          approval: state === "authorized" ? { decision: "approved", note: "Exact", decided_at_ms: 2 } : null,
          submission: null, execution: null, audit_history: [],
        },
      },
    },
  } as Task;
}

describe("Mission projection", () => {
  it.each([
    ["awaiting_approval", "awaiting_approval"], ["authorized", "authorized"],
    ["submitted", "submitted"], ["confirmed", "completed"], ["rejected", "cancelled"],
  ] as const)("maps Flow %s to Mission %s", (input, output) => {
    expect(missionStateForTask(flowTask(input))).toBe(output);
  });

  it("creates an exact native transfer intent", () => {
    const intent = transactionIntentForTask(flowTask("awaiting_approval"));
    expect(intent).toMatchObject({
      kind: "native_transfer", chain_id: 10143, asset: "MON", amount: "1",
      calldata: "0x", idempotency_key: "flow:00000000-0000-4000-8000-000000000002",
    });
    expect(intent?.calldata_hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("projects every batch payout into an independently idempotent intent", () => {
    const task = flowTask("awaiting_approval");
    if (task.status.state !== "completed" || task.bot !== "flow") throw new Error("Unexpected fixture.");
    task.status.data.workflow.payouts.push({ recipient_name: "Second", recipient_address: "0x3333333333333333333333333333333333333333", asset: "MON", amount: "1", milestone: "Test", deadline: null });
    const intents = transactionIntentsForTask(task);
    expect(intents).toHaveLength(2);
    expect(new Set(intents.map((intent) => intent.id)).size).toBe(2);
    expect(intents.map((intent) => intent.idempotency_key)).toEqual(["flow:00000000-0000-4000-8000-000000000002", "flow:00000000-0000-4000-8000-000000000002:1"]);
  });
});
