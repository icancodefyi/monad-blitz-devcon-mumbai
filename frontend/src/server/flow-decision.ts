import type { FlowCompletedTask } from "@/lib/donads-api";
import { taskEvent } from "@/server/donads-types";

export type FlowDecision =
  | { action: "approve"; note?: string }
  | { action: "reject"; reason?: string };

export type FlowDecisionChannel = "web" | "telegram";

/**
 * Records the owner's decision on an exact Flow transfer intent.
 *
 * Approval only moves the intent to `authorized`; the owner's wallet must still
 * sign and broadcast every transaction. Returns `true` when the intent had
 * already left `awaiting_approval`, in which case the task is left unchanged.
 */
export function applyFlowDecision(task: FlowCompletedTask, decision: FlowDecision, channel: FlowDecisionChannel, now = Date.now()): boolean {
  const workflow = task.status.data.workflow;
  if (workflow.state !== "awaiting_approval") return true;
  const via = channel === "telegram" ? " via Telegram" : "";
  if (decision.action === "approve") {
    workflow.state = "authorized";
    workflow.approval = { decision: "approved", note: decision.note ?? "Exact transfer approved.", decided_at_ms: now };
    workflow.audit_history.push({ sequence: workflow.audit_history.length + 1, event: "intent_authorized", detail: `User authorized the exact transfer${via}; wallet signature still required.`, at_ms: now });
    task.status.summary = "Flow recorded approval and is waiting for the wallet transaction.";
  } else {
    workflow.state = "rejected";
    workflow.approval = { decision: "rejected", note: decision.reason ?? "Rejected.", decided_at_ms: now };
    workflow.audit_history.push({ sequence: workflow.audit_history.length + 1, event: "intent_rejected", detail: `User rejected the transfer intent${via}.`, at_ms: now });
    task.status.summary = "Flow transfer intent rejected; no funds moved.";
  }
  task.updated_at_ms = now;
  task.events.push(taskEvent(task.events, decision.action, task.status.summary, now));
  return false;
}
