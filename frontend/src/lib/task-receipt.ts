import type { TaskBase } from "@/lib/donads-api";

import { MONAD_TESTNET } from "@/lib/chain-config";

export const MONAD_TESTNET_EXPLORER = MONAD_TESTNET.explorerUrl;

export function formatTaskDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  if (totalSeconds === 0) return "<1s";

  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function taskCompletionTime(task: TaskBase): number {
  return Math.max(task.updated_at_ms, ...task.events.map((event) => event.at_ms));
}
