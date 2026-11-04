import type { CompletedTask, Task } from "@/lib/donads-api";

const MAX_TITLE_LENGTH = 58;

function hostname(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
}

export function createTaskTitle(prompt: string, bot = "task"): string {
  const normalized = prompt
    .replace(/https?:\/\/[^\s<>"]+/gi, (value) => hostname(value.replace(/[),.;!?]+$/g, "")))
    .replace(/0x[a-fA-F0-9]{40,}/g, (value) => `${value.slice(0, 6)}…${value.slice(-4)}`)
    .replace(/\b(?:please|could you|can you|i want you to|would you)\b/gi, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?;,]+$/g, "");

  const fallback = `${bot.charAt(0).toUpperCase()}${bot.slice(1)} task`;
  if (!normalized) return fallback;
  if (normalized.length <= MAX_TITLE_LENGTH) return normalized.charAt(0).toUpperCase() + normalized.slice(1);

  const candidate = normalized.slice(0, MAX_TITLE_LENGTH + 1);
  const boundary = candidate.lastIndexOf(" ");
  const shortened = candidate.slice(0, boundary > 30 ? boundary : MAX_TITLE_LENGTH).trimEnd();
  return `${shortened}…`;
}

export function taskDisplayTitle(task: Pick<Task, "title" | "prompt" | "bot">): string {
  return task.title?.trim() || createTaskTitle(task.prompt, task.bot);
}

export function canDeleteTaskHistory(task: Task): { allowed: boolean; reason: string | null } {
  if (task.status.state === "queued" || task.status.state === "running") {
    return { allowed: false, reason: "Wait for this task to finish before deleting it from history." };
  }
  if (task.status.state === "failed") return { allowed: true, reason: null };
  const completed = task as CompletedTask;
  if (completed.bot === "flow" && !["confirmed", "rejected"].includes(completed.status.data.workflow.state)) {
    return { allowed: false, reason: "Confirm or reject the payment before deleting this history item." };
  }
  if (completed.bot === "commerce" && !["completed", "rejected"].includes(completed.status.data.workflow.state)) {
    return { allowed: false, reason: "Complete or reject the checkout before deleting this history item." };
  }
  if (completed.bot === "operator" && ["planned", "running", "cancelling"].includes(completed.status.data.workflow.state)) {
    return { allowed: false, reason: "Wait for the coordinated workflow to stop before deleting it." };
  }
  return { allowed: true, reason: null };
}
