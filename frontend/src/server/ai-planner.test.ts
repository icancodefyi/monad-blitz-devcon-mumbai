import { afterEach, describe, expect, it, vi } from "vitest";
import { planTask } from "./ai-planner";

describe("AI planner fallback", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses deterministic routing when the Gemini key is absent", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const result = await planTask("0x1111111111111111111111111111111111111111", "Research https://example.com");
    expect(result.mode).toBe("deterministic");
    expect(result.plan.kind).toBe("scout");
    expect(result.fallback_reason).toMatch(/not configured/i);
  });

  it("keeps payments at a clarification boundary without the model", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const result = await planTask("0x1111111111111111111111111111111111111111", "Pay this person");
    expect(result.plan.kind).toBe("clarify");
  });

  it("keeps complete payment values outside the model", async () => {
    vi.stubEnv("GEMINI_API_KEY", "configured-but-unused");
    const result = await planTask(
      "0x1111111111111111111111111111111111111111",
      "Send 0.1 MON to 0x2222222222222222222222222222222222222222",
    );
    expect(result.mode).toBe("deterministic");
    expect(result.plan).toMatchObject({ kind: "flow", amount: "0.1" });
    expect(result.fallback_reason).toMatch(/outside the model/i);
  });
});
