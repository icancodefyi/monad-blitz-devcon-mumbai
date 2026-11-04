// Scheduled payments. A schedule stores an exact batch (recipients and amount
// each). Every run prepares that batch as a normal Flow transfer intent, which
// sends the Telegram approval; the owner's wallet must still sign. A schedule
// never signs or moves funds on its own.

import { randomUUID } from "node:crypto";

import { getAddress, isAddress } from "viem";

import type { Task } from "@/lib/donads-api";
import { claimDueSchedules, countActiveSchedules, getTask, putSchedule, setScheduleLastTask, type PaymentSchedule } from "@/server/database";
import { createAndExecuteTask } from "@/server/tasks";

export const MIN_INTERVAL_MINUTES = 2;
export const MAX_INTERVAL_MINUTES = 60 * 24 * 30;
export const MAX_ACTIVE_SCHEDULES = 5;
export const MAX_RECIPIENTS = 10;

export type ScheduleRequest = { recipients: unknown; amount_each: unknown; interval_minutes: unknown; first_run_ms?: unknown };

export function validateScheduleRequest(request: ScheduleRequest, now = Date.now()): { recipients: string[]; amount_each: string; interval_minutes: number; first_run_ms: number } {
  const raw = Array.isArray(request.recipients) ? request.recipients.map(String) : [];
  const recipients = [...new Set(raw.map((value) => value.trim().toLowerCase()))];
  if (!recipients.length || recipients.length > MAX_RECIPIENTS) throw new Error(`A schedule needs 1 to ${MAX_RECIPIENTS} unique recipients.`);
  if (recipients.some((value) => !isAddress(value))) throw new Error("Every schedule recipient must be a valid EVM address.");
  const amount = String(request.amount_each ?? "").trim();
  if (!/^\d+(?:\.\d{1,18})?$/.test(amount) || Number(amount) <= 0) throw new Error("Amount per recipient must be a positive MON value with up to 18 decimals.");
  const interval = Number(request.interval_minutes);
  if (!Number.isInteger(interval) || interval < MIN_INTERVAL_MINUTES || interval > MAX_INTERVAL_MINUTES) throw new Error(`The interval must be between ${MIN_INTERVAL_MINUTES} minutes and 30 days.`);
  const firstRun = request.first_run_ms === undefined ? now + interval * 60_000 : Number(request.first_run_ms);
  if (!Number.isSafeInteger(firstRun) || firstRun < now - 60_000 || firstRun > now + MAX_INTERVAL_MINUTES * 60_000) throw new Error("The first run time is invalid.");
  return { recipients: recipients.map((value) => getAddress(value)), amount_each: amount, interval_minutes: interval, first_run_ms: firstRun };
}

export async function createSchedule(ownerId: string, request: ScheduleRequest, now = Date.now()): Promise<PaymentSchedule> {
  const valid = validateScheduleRequest(request, now);
  if (await countActiveSchedules(ownerId) >= MAX_ACTIVE_SCHEDULES) throw new Error(`You already have ${MAX_ACTIVE_SCHEDULES} active schedules. Stop one first.`);
  const schedule: PaymentSchedule = {
    schedule_id: randomUUID(), owner_id: ownerId, recipients: valid.recipients, amount_each: valid.amount_each,
    interval_minutes: valid.interval_minutes, next_run_ms: valid.first_run_ms, active: true, runs: 0, last_task_id: null, created_at_ms: now,
  };
  await putSchedule(schedule);
  return schedule;
}

/** A previous run is still open if its transfer intent has not reached a terminal state. */
export function runStillOpen(task: Task | null): boolean {
  if (!task || task.bot !== "flow" || task.status.state !== "completed") return false;
  return ["awaiting_approval", "authorized", "submitted"].includes(task.status.data.workflow.state);
}

export function scheduledFlowInput(schedule: PaymentSchedule): Record<string, unknown> {
  return {
    title: `Scheduled batch, run ${schedule.runs}`,
    purpose: `Scheduled payment: ${schedule.amount_each} MON to each of ${schedule.recipients.length} recipient(s), every ${schedule.interval_minutes} minutes`,
    payer: schedule.owner_id,
    payouts: schedule.recipients.map((recipient, index) => ({
      recipient_name: `Recipient ${index + 1}`, recipient_address: recipient, asset: "MON", amount: schedule.amount_each,
      milestone: `Scheduled run ${schedule.runs}`, deadline: null, token_contract: null,
    })),
    approval_conditions: ["Exact sender, every recipient, every amount, total value, and Monad Testnet chain approved"],
    linked_task_id: null,
  };
}

export type ScheduleRunResult = { schedule_id: string; outcome: "prepared" | "skipped_open_run" | "failed"; task_id: string | null; error?: string };

/** Prepares due runs. Each run is a Flow intent awaiting the owner's approval. */
export async function runDueSchedules(now = Date.now()): Promise<ScheduleRunResult[]> {
  const due = await claimDueSchedules(now);
  const results: ScheduleRunResult[] = [];
  for (const schedule of due) {
    try {
      if (schedule.last_task_id && runStillOpen(await getTask(schedule.owner_id, schedule.last_task_id))) {
        results.push({ schedule_id: schedule.schedule_id, outcome: "skipped_open_run", task_id: schedule.last_task_id });
        continue;
      }
      const input = scheduledFlowInput(schedule);
      const task = await createAndExecuteTask(schedule.owner_id, { prompt: String(input.purpose), bot: "flow", input });
      await setScheduleLastTask(schedule.schedule_id, task.id);
      results.push({ schedule_id: schedule.schedule_id, outcome: task.status.state === "completed" ? "prepared" : "failed", task_id: task.id, error: task.status.state === "failed" ? task.status.error : undefined });
    } catch (cause) {
      results.push({ schedule_id: schedule.schedule_id, outcome: "failed", task_id: null, error: cause instanceof Error ? cause.message : "Scheduled run failed." });
    }
  }
  return results;
}
