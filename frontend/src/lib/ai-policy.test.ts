import { describe, expect, it } from "vitest";
import { DONADS_AI_POLICY, isRetryableAiError, type AiProviderError } from "./ai-policy";

describe("DONADS AI policy", () => {
  it("locks the approved free-user limits", () => {
    expect(DONADS_AI_POLICY).toEqual({
      requestsPerMinutePerWallet: 3,
      requestsPerDayPerWallet: 30,
      concurrentRequestsPerWallet: 1,
      maxAttachmentsPerTask: 5,
      maxAttachmentBytes: 10_485_760,
      maxInputTokensPerTask: 20_000,
      maxOutputTokensPerTask: 2_000,
      timeoutMs: 30_000,
      transientRetryCount: 1,
    });
  });

  it("never retries invalid input or provider rate limits", () => {
    const invalid = Object.assign(new Error("invalid"), { status: 400 }) as AiProviderError;
    const limited = Object.assign(new Error("limited"), { status: 429 }) as AiProviderError;
    expect(isRetryableAiError(invalid)).toBe(false);
    expect(isRetryableAiError(limited)).toBe(false);
  });

  it("allows one retry for transient failures", () => {
    const unavailable = Object.assign(new Error("unavailable"), { status: 503 }) as AiProviderError;
    expect(isRetryableAiError(unavailable)).toBe(true);
  });
});
