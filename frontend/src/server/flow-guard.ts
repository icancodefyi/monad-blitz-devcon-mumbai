import type { Task } from "@/lib/donads-api";
import { lookalikeOf } from "@/lib/lookalike";
import { listTasks } from "@/server/database";

/** Recipients the owner has actually paid or is paying through DONADS. */
export function paidRecipients(tasks: Task[]): Set<string> {
  const recipients = new Set<string>();
  for (const task of tasks) {
    if (task.bot !== "flow" || task.status.state !== "completed") continue;
    const workflow = task.status.data.workflow;
    if (!["submitted", "confirmed"].includes(workflow.state)) continue;
    for (const payout of workflow.payouts) recipients.add(payout.recipient_address.toLowerCase());
  }
  return recipients;
}

/** Explains why a Flow input must be stopped, or returns null when it is safe to prepare. */
export function lookalikeProblem(input: unknown, known: Set<string>): string | null {
  const payouts = input && typeof input === "object" && Array.isArray((input as { payouts?: unknown }).payouts) ? (input as { payouts: Array<{ recipient_address?: unknown }> }).payouts : [];
  for (const payout of payouts) {
    const recipient = String(payout.recipient_address ?? "");
    const imitated = lookalikeOf(recipient, known);
    if (imitated) {
      return `Stopped: ${recipient} looks like ${imitated}, an address you have paid before, but it is a different address. This is how address-poisoning scams work. Check the full address with the person you are paying. No transfer was prepared.`;
    }
  }
  return null;
}

export async function lookalikeRecipientError(ownerId: string, input: unknown): Promise<string | null> {
  return lookalikeProblem(input, paidRecipients(await listTasks(ownerId, 100)));
}
