import { randomUUID } from "node:crypto";

import type { Task } from "@/lib/donads-api";
import { executeBot } from "@/server/bots";
import { insertTask, updateTask } from "@/server/database";
import { taskEvent } from "@/server/donads-types";
import { sendCheckpointNotifications } from "@/server/checkpoint-notifications";
import { createTaskTitle } from "@/lib/task-history";
import { lookalikeRecipientError } from "@/server/flow-guard";

function persistedInput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.attachments)) return input;
  return { ...input, attachments: input.attachments.map((attachment) => {
    if (!attachment || typeof attachment !== "object") return { name: "attachment" };
    const item = attachment as Record<string, unknown>;
    return { name: String(item.name ?? "attachment"), mime_type: String(item.mime_type ?? "application/octet-stream"), data_redacted: true };
  }) };
}

export async function createAndExecuteTask(
  ownerId: string,
  payload: Record<string, unknown>,
): Promise<Task> {
  const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
  const bot = typeof payload.bot === "string" ? payload.bot.trim().toLowerCase() : "";
  if (!prompt) throw new Error("prompt is required.");
  if (!bot) throw new Error("bot is required.");
  const now = Date.now();
  const executionInput = payload.input ?? {};
  const task = {
    id: randomUUID(), owner_id: ownerId, title: createTaskTitle(prompt, bot), prompt, bot, input: persistedInput(executionInput),
    events: [{ sequence: 1, kind: "queued", message: `${bot} task accepted.`, at_ms: now }],
    created_at_ms: now, updated_at_ms: now, feedback: null, status: { state: "running" as const },
  } as Task;
  await insertTask(task);
  try {
    if (bot === "flow") {
      const lookalike = await lookalikeRecipientError(ownerId, executionInput);
      if (lookalike) throw new Error(lookalike);
    }
    task.status = await executeBot(bot, executionInput, ownerId) as Task["status"];
    task.updated_at_ms = Date.now();
    task.events.push(taskEvent(task.events, "completed", task.status.state === "completed" ? task.status.summary : "Task completed."));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Specialist execution failed.";
    task.status = { state: "failed", error: message, latency_ms: Date.now() - now };
    task.updated_at_ms = Date.now();
    task.events.push(taskEvent(task.events, "failed", message));
  }
  await updateTask(task);
  await sendCheckpointNotifications(task);
  return task;
}
