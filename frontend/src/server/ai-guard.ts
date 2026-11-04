import { randomUUID } from "node:crypto";
import { DONADS_AI_POLICY } from "@/lib/ai-policy";
import { acquireAiLease, recordAiUsage, releaseAiLease, takeRateLimit } from "@/server/database";

export type AiRequestLease = { requestId: string; ownerId: string };

export async function beginAiRequest(ownerId: string, inputTokens: number, provider: string, model: string): Promise<AiRequestLease> {
  if (!Number.isInteger(inputTokens) || inputTokens < 0) throw new Error("AI input token count must be a non-negative integer.");
  if (inputTokens > DONADS_AI_POLICY.maxInputTokensPerTask) throw new Error(`AI input exceeds the ${DONADS_AI_POLICY.maxInputTokensPerTask.toLocaleString()} token limit.`);
  const requestId = randomUUID();
  const leased = await acquireAiLease(ownerId, requestId, Date.now() + DONADS_AI_POLICY.timeoutMs + 5_000);
  if (!leased) throw new Error("One AI task is already running for this wallet.");
  try {
    if (!await takeRateLimit(`ai-minute:${ownerId}`, DONADS_AI_POLICY.requestsPerMinutePerWallet, 60_000)) throw new Error("AI limit reached: 3 requests per minute per wallet.");
    if (!await takeRateLimit(`ai-day:${ownerId}`, DONADS_AI_POLICY.requestsPerDayPerWallet, 24 * 60 * 60 * 1_000)) throw new Error("AI daily limit reached: 30 requests per wallet.");
    await recordAiUsage({ requestId, ownerId, provider, model, inputTokens, outputTokens: 0, status: "running" });
    return { requestId, ownerId };
  } catch (error) {
    await releaseAiLease(ownerId, requestId);
    throw error;
  }
}

export async function finishAiRequest(lease: AiRequestLease, usage: { provider: string; model: string; inputTokens: number; outputTokens: number; status: "completed" | "failed" | "fallback" }): Promise<void> {
  try {
    if (usage.inputTokens > DONADS_AI_POLICY.maxInputTokensPerTask) {
      await recordAiUsage({ requestId: lease.requestId, ownerId: lease.ownerId, ...usage, status: "failed" });
      throw Object.assign(new Error(`AI input exceeds the ${DONADS_AI_POLICY.maxInputTokensPerTask.toLocaleString()} token limit.`), { status: 400 });
    }
    if (usage.outputTokens > DONADS_AI_POLICY.maxOutputTokensPerTask) {
      await recordAiUsage({ requestId: lease.requestId, ownerId: lease.ownerId, ...usage, status: "failed" });
      throw Object.assign(new Error(`AI output exceeds the ${DONADS_AI_POLICY.maxOutputTokensPerTask.toLocaleString()} token limit.`), { status: 400 });
    }
    await recordAiUsage({ requestId: lease.requestId, ownerId: lease.ownerId, ...usage });
  }
  finally { await releaseAiLease(lease.ownerId, lease.requestId); }
}
