import { DONADS_AI_POLICY, isRetryableAiError, type AiProviderError } from "@/lib/ai-policy";
import { beginAiRequest, finishAiRequest } from "@/server/ai-guard";

export type GeminiAttachment = { name: string; mimeType: string; data: string };
type GeminiUsage = { promptTokenCount?: number; candidatesTokenCount?: number };
type GeminiResponse = { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; usageMetadata?: GeminiUsage; error?: { message?: string; code?: number } };

export function geminiConfigured(): boolean { return Boolean(process.env.GEMINI_API_KEY?.trim()); }

export async function generateGeminiJson<T>(input: { ownerId: string; system: string; prompt: string; schema: Record<string, unknown>; attachments?: GeminiAttachment[] }): Promise<T | null> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;
  const model = process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
  const estimatedInputTokens = Math.ceil((input.system.length + input.prompt.length) / 4);
  const lease = await beginAiRequest(input.ownerId, estimatedInputTokens, "gemini", model);
  let lastError: unknown;
  let leaseClosed = false;
  for (let attempt = 0; attempt <= DONADS_AI_POLICY.transientRetryCount; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DONADS_AI_POLICY.timeoutMs);
    try {
      const parts: Array<Record<string, unknown>> = [{ text: input.prompt }];
      for (const attachment of input.attachments ?? []) parts.push({ inline_data: { mime_type: attachment.mimeType, data: attachment.data } });
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: input.system }] },
          contents: [{ role: "user", parts }],
          generationConfig: { responseMimeType: "application/json", responseJsonSchema: input.schema, maxOutputTokens: DONADS_AI_POLICY.maxOutputTokensPerTask, temperature: 0.2 },
        }),
        signal: controller.signal,
      });
      const payload = await response.json() as GeminiResponse;
      if (!response.ok) throw Object.assign(new Error(payload.error?.message ?? `Gemini returned HTTP ${response.status}.`), { status: response.status }) as AiProviderError;
      const raw = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
      if (!raw) throw new Error("Gemini returned no structured output.");
      const usage = payload.usageMetadata ?? {};
      try { await finishAiRequest(lease, { provider: "gemini", model, inputTokens: usage.promptTokenCount ?? estimatedInputTokens, outputTokens: usage.candidatesTokenCount ?? Math.ceil(raw.length / 4), status: "completed" }); }
      finally { leaseClosed = true; }
      return JSON.parse(raw) as T;
    } catch (error) {
      lastError = error;
      if (attempt >= DONADS_AI_POLICY.transientRetryCount || !isRetryableAiError(error)) break;
    } finally { clearTimeout(timeout); }
  }
  if (!leaseClosed) await finishAiRequest(lease, { provider: "gemini", model, inputTokens: estimatedInputTokens, outputTokens: 0, status: "fallback" });
  throw lastError instanceof Error ? lastError : new Error("Gemini request failed.");
}
