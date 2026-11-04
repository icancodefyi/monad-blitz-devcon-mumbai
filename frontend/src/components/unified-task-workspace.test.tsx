import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { FlowCompletedTask } from "@/lib/donads-api";
import { UnifiedTaskWorkspace } from "./unified-task-workspace";

const flowTask = {
  id: "00000000-0000-4000-8000-000000000001", owner_id: "0x1111111111111111111111111111111111111111", prompt: "Send 0.01 MON", bot: "flow", input: {}, events: [], created_at_ms: 1, updated_at_ms: 2, feedback: null,
  status: { state: "completed", summary: "Prepared", latency_ms: 1, data: { agent_version: "test", execution_available: false, blocked_reason: "Wallet approval required.", workflow: {
    id: "00000000-0000-4000-8000-000000000002", title: "Transfer", purpose: "Test", payer: "0x1111111111111111111111111111111111111111", network: "Monad Testnet", chain_id: 10143, transfer_kind: "native", token: null, state: "awaiting_approval",
    payouts: [{ recipient_name: "Recipient", recipient_address: "0x2222222222222222222222222222222222222222", asset: "MON", amount: "0.01", milestone: "Test", deadline: null, amount_atomic: null, token_contract: null }], totals: [{ asset: "MON", amount: "0.01" }], total_atomic: "10000000000000000", approval_conditions: [], linked_task_id: null, approval: null, submission: null, submissions: [], execution: null, executions: [], audit_history: [],
  } } },
} as FlowCompletedTask;

describe("unified financial verification UI", () => {
  it("renders the deterministic calldata panel and overflow-safe quick inserts", () => {
    render(<UnifiedTaskWorkspace signedIn walletAddress={flowTask.owner_id} initialTask={flowTask} addressSuggestions={[{ label: "Last recipient", address: "0x2222222222222222222222222222222222222222" }]} />);
    expect(screen.getByText("Deterministic verification & calldata diff")).toBeInTheDocument();
    expect(screen.getByText(/LLM bypassed/)).toBeInTheDocument();
    const quickInsert = screen.getByRole("button", { name: /Last recipient/ });
    expect(quickInsert.parentElement).toHaveClass("overflow-x-auto");
  });
});
