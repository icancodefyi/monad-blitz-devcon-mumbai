import type { CompletedTask } from "@/lib/donads-api";

function concise(value: string, limit = 420): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

export function taskResponseText(task: CompletedTask): string {
  if (task.bot === "scout") {
    const { report } = task.status.data;
    const findings = report.findings.slice(0, 6).map((finding) => `• ${concise(finding.text)} ${finding.citations.map((id) => `[${id}]`).join(" ")}`);
    const sources = report.sources.filter((source) => source.status === "fetched").map((source) => `[${source.id}] ${source.title} — ${source.url}`);
    const screen = task.status.data.securityScreen;
    const shield = screen?.passed ? "Shield: Prompt-Injection & Phishing Screened (SHA-256 Verified)" : screen ? "Warning: Indirect Prompt-Injection Attempt Neutralized in Source" : null;
    const verification = task.status.data.deliverableVerification;
    const escrow = verification ? ["", "Escrow deliverable check", `Recommended action: ${verification.recommendedAction}.`, `Evidence hash: ${verification.contentHash ?? "unavailable"}.`, verification.blockedReason ?? `Sentinel verdict: ${verification.sentinelVerdict.verdict}. Review the deterministic checkpoint before signing.`] : [];
    return [shield, report.title, ...(findings.length ? findings : ["No source text passed verification for a supported answer."]), "", "Evidence", ...sources, ...escrow, "", report.limitations].filter((line) => line !== null).join("\n");
  }

  if (task.bot === "growth") {
    const { campaign } = task.status.data;
    const drafts = campaign.calendar.slice(0, 7).map((day) => `• Day ${day.day} · ${day.platform}: ${concise(day.draft, 260)} CTA: ${concise(day.call_to_action, 120)}`);
    return [`${campaign.project_name}: ${campaign.calendar.length} review-ready drafts for ${campaign.target_audience}.`, ...drafts, "", "Nothing was published; every draft remains editable."].join("\n");
  }

  if (task.bot === "sentinel") {
    const findings = task.status.data.findings.map((finding) => `• ${finding.severity.toUpperCase()}: ${finding.title}. ${finding.evidence}`);
    return [task.status.summary, ...(findings.length ? findings : ["• No deterministic opcode risk signals were detected in the executable bytecode."]), "", task.status.data.disclaimer].join("\n");
  }

  if (task.bot === "operator") {
    const { workflow } = task.status.data;
    const steps = workflow.steps.map((step) => `• ${step.bot}: ${step.summary ? concise(step.summary, 280) : `${step.title} — ${step.status}`}`);
    return [`${task.status.summary} ${workflow.steps.filter((step) => step.status === "completed").length}/${workflow.steps.length} specialist steps completed.`, ...steps].join("\n");
  }

  if (task.bot === "commerce") {
    const { workflow } = task.status.data;
    return [task.status.summary, `Selected: ${workflow.selected_offer.name} from ${workflow.selected_offer.merchant}.`, `Total: ${workflow.total_atomic} ${workflow.asset} atomic units.`, task.status.data.blocked_reason].join("\n");
  }

  const { workflow } = task.status.data;
  const payout = workflow.payouts[0];
  const executions = workflow.executions ?? (workflow.execution ? [{ payout_index: 0, ...workflow.execution }] : []);
  if (workflow.payouts.length > 1) {
    const recipients = workflow.payouts.map((item, index) => `${index + 1}. ${item.amount} ${item.asset} to ${item.recipient_address}.`).join("\n");
    const verified = executions.length === workflow.payouts.length ? `${executions.length} independently verified Monad receipts.` : task.status.data.blocked_reason;
    return [task.status.summary, `Total: ${workflow.totals[0]?.amount} ${workflow.totals[0]?.asset}.`, recipients, verified].filter(Boolean).join("\n");
  }
  const verified = workflow.execution ? `Verified in block ${workflow.execution.block_number}. Transaction: ${workflow.execution.transaction_hash}` : task.status.data.blocked_reason;
  return [task.status.summary, payout ? `${payout.amount} ${payout.asset} to ${payout.recipient_address}.` : "", verified].filter(Boolean).join("\n");
}

export function shouldOfferPdf(task: CompletedTask): boolean {
  if (task.bot === "operator") return task.status.data.workflow.state === "completed" && task.status.data.workflow.steps.length >= 2;
  if (task.bot === "growth") return task.status.data.campaign.calendar.length >= 7;
  if (task.bot === "commerce") return task.status.data.workflow.state === "completed";
  if (task.bot === "flow") return task.status.data.workflow.state === "confirmed";
  return false;
}
