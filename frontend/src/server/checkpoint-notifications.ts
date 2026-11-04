import type { Task } from "@/lib/donads-api";
import { sendTelegramCheckpoint } from "@/server/telegram";

// Telegram is the only checkpoint channel: transfer approvals and wallet
// signature reminders are delivered to the owner's linked private chat.
export async function sendCheckpointNotifications(task: Task): Promise<void> {
  try {
    await sendTelegramCheckpoint(task);
  } catch (reason) {
    console.error("DONADS Telegram checkpoint failed", reason);
  }
}
