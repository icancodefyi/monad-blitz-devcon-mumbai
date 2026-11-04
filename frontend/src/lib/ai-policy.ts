export const DONADS_AI_POLICY = Object.freeze({
  requestsPerMinutePerWallet: 3,
  requestsPerDayPerWallet: 30,
  concurrentRequestsPerWallet: 1,
  maxAttachmentsPerTask: 5,
  maxAttachmentBytes: 10 * 1024 * 1024,
  maxInputTokensPerTask: 20_000,
  maxOutputTokensPerTask: 2_000,
  timeoutMs: 30_000,
  transientRetryCount: 1,
} as const);

export type AiProviderError = Error & { status?: number; code?: string };

export function isRetryableAiError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const providerError = error as AiProviderError;
  if (providerError.status === 429) return false;
  if (providerError.status && providerError.status >= 400 && providerError.status < 500) return false;
  return providerError.name === "AbortError" || providerError.status === undefined || providerError.status >= 500;
}
