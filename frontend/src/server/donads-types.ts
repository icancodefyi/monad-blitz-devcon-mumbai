import type { CompletedTask, Task, TaskEvent } from "@/lib/donads-api";

export type StoredTask = Task;
export type NewTask = {
  id: string;
  owner_id: string;
  title: string;
  prompt: string;
  bot: string;
  input: unknown;
  events: TaskEvent[];
  created_at_ms: number;
  updated_at_ms: number;
  feedback: null;
  status: { state: "queued" | "running" };
};

export type BotExecution = CompletedTask["status"];

export function taskEvent(
  events: TaskEvent[],
  kind: string,
  message: string,
  at = Date.now(),
): TaskEvent {
  return { sequence: events.length + 1, kind, message, at_ms: at };
}
