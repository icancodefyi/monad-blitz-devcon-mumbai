import type { Task } from "@/lib/donads-api";

export const APPROVAL_REMINDER_AFTER_MS = 2 * 60 * 1_000;

export type PendingApproval = {
  task_id: string;
  bot: "flow" | "commerce" | "operator";
  kind: "intent_review" | "wallet_signature" | "receipt_verification" | "workflow_start";
  title: string;
  summary: string;
  state: string;
  requested_at_ms: number;
  reminder_due: boolean;
};

export function pendingApprovalForTask(task: Task, now = Date.now()): PendingApproval | null {
  if (task.status.state !== "completed") return null;

  if (task.bot === "flow") {
    const workflow = task.status.data.workflow;
    if (workflow.state === "awaiting_approval") {
      const payout = workflow.payouts[0];
      if (!payout) return null;
      const batch = workflow.payouts.length > 1;
      return approval(task, now, {
        bot: "flow",
        kind: "intent_review",
        title: batch ? `Review ${payout.asset} batch` : `Review ${payout.asset} transfer`,
        summary: batch ? `${workflow.totals[0]?.amount} ${payout.asset} across ${workflow.payouts.length} recipients` : `${payout.amount} ${payout.asset} to ${shortAddress(payout.recipient_address)}`,
        state: workflow.state,
        requested_at_ms: task.updated_at_ms,
      });
    }
    if (workflow.state === "authorized") {
      const payout = workflow.payouts[0];
      if (!payout) return null;
      return approval(task, now, {
        bot: "flow",
        kind: "wallet_signature",
        title: "Wallet signature required",
        summary: workflow.payouts.length > 1 ? `Confirm ${workflow.payouts.length} exact transactions in your wallet` : `Confirm ${payout.amount} ${payout.asset} in your mobile wallet`,
        state: workflow.state,
        requested_at_ms: workflow.approval?.decided_at_ms ?? task.updated_at_ms,
      });
    }
    if (workflow.state === "submitted" && (workflow.submissions?.length || workflow.submission)) {
      const submissions = workflow.submissions ?? [{ payout_index: 0, ...workflow.submission! }];
      const verified = workflow.executions?.length ?? (workflow.execution ? 1 : 0);
      return approval(task, now, {
        bot: "flow",
        kind: "receipt_verification",
        title: "Verify submitted transfer",
        summary: submissions.length > 1 ? `Verify ${submissions.length - verified} remaining Monad receipt(s)` : `Check receipt ${shortHash(submissions[0].transaction_hash)}`,
        state: workflow.state,
        requested_at_ms: submissions.at(-1)!.submitted_at_ms,
      });
    }
  }

  if (task.bot === "commerce" && task.status.data.workflow.state === "awaiting_approval") {
    const workflow = task.status.data.workflow;
    return approval(task, now, {
      bot: "commerce",
      kind: "intent_review",
      title: "Review purchase intent",
      summary: `${workflow.selected_offer.name} · ${workflow.total_atomic} ${workflow.asset}`,
      state: workflow.state,
      requested_at_ms: task.updated_at_ms,
    });
  }

  if (task.bot === "operator" && task.status.data.workflow.state === "planned") {
    return approval(task, now, {
      bot: "operator",
      kind: "workflow_start",
      title: "Start coordinated workflow",
      summary: task.status.data.workflow.objective,
      state: task.status.data.workflow.state,
      requested_at_ms: task.updated_at_ms,
    });
  }

  return null;
}

export function pendingApprovals(tasks: Task[], now = Date.now()): PendingApproval[] {
  return tasks
    .map((task) => pendingApprovalForTask(task, now))
    .filter((value): value is PendingApproval => value !== null)
    .sort((left, right) => left.requested_at_ms - right.requested_at_ms);
}

function approval(
  task: Task,
  now: number,
  value: Omit<PendingApproval, "task_id" | "reminder_due">,
): PendingApproval {
  return {
    task_id: task.id,
    ...value,
    reminder_due: now - value.requested_at_ms >= APPROVAL_REMINDER_AFTER_MS,
  };
}

function shortAddress(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function shortHash(value: string): string {
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}
