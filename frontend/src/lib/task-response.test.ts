import { describe, expect, it } from "vitest";
import type { CompletedTask } from "@/lib/donads-api";
import { shouldOfferPdf, taskResponseText } from "@/lib/task-response";

const base = { id: "00000000-0000-4000-8000-000000000001", owner_id: "0x0000000000000000000000000000000000000001", prompt: "Research", input: {}, events: [], created_at_ms: 1, updated_at_ms: 2, feedback: null };

describe("chat-first task responses", () => {
  it("renders Scout evidence and sources directly in chat without offering a PDF", () => {
    const task = { ...base, bot: "scout", status: { state: "completed", summary: "Done", data: { report: { title: "Research", findings: [{ text: "Monad is an EVM-compatible network.", citations: [1] }], sources: [{ id: 1, title: "Monad", url: "https://monad.xyz", status: "fetched", error: null }], limitations: "Verify important claims." }, agent_version: "test", read_only: true }, latency_ms: 1 } } as CompletedTask;
    expect(taskResponseText(task)).toContain("Monad is an EVM-compatible network. [1]");
    expect(taskResponseText(task)).toContain("https://monad.xyz");
    expect(shouldOfferPdf(task)).toBe(false);
  });

  it("offers PDF only for a completed formal Operator workflow", () => {
    const task = { ...base, bot: "operator", status: { state: "completed", summary: "Completed", data: { workflow: { state: "completed", steps: [{}, {}], cancellation_requested: false }, agent_version: "operator-orchestration-v2", external_actions: false }, latency_ms: 1 } } as unknown as CompletedTask;
    expect(shouldOfferPdf(task)).toBe(true);
  });

  it("keeps small Operator responses in chat only", () => {
    const task = { ...base, bot: "operator", status: { state: "completed", summary: "Completed", data: { workflow: { state: "completed", steps: [{}], cancellation_requested: false }, agent_version: "operator-orchestration-v2", external_actions: false }, latency_ms: 1 } } as unknown as CompletedTask;
    expect(shouldOfferPdf(task)).toBe(false);
  });
});
