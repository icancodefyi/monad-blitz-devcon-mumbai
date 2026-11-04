import { planUnifiedTask, type UnifiedPlan } from "@/lib/task-planner";
import { generateGeminiJson, geminiConfigured, type GeminiAttachment } from "@/server/gemini";

type ModelPlan = { kind: string; message?: string; prompt?: string; objective?: string; sources?: string[]; bytecode?: string };

const schema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["scout", "growth", "operator", "sentinel", "clarify"] },
    message: { type: "string" }, prompt: { type: "string" }, objective: { type: "string" },
    sources: { type: "array", items: { type: "string" }, maxItems: 5 }, bytecode: { type: "string" },
  },
  required: ["kind"], additionalProperties: false,
};

function validateModelPlan(value: ModelPlan, original: string): UnifiedPlan {
  const suppliedUrls = new Set(original.match(/https?:\/\/[^\s<>"']+/gi)?.map((url) => url.replace(/[),.;!?]+$/g, "")) ?? []);
  if (value.kind === "sentinel" && /^0x[0-9a-f]{4,}$/i.test(value.bytecode ?? "")) return { kind: "sentinel", bytecode: value.bytecode! };
  if (value.kind === "scout") return { kind: "scout", prompt: original };
  if (value.kind === "growth") return { kind: "growth", objective: value.objective?.trim() || original };
  if (value.kind === "operator") { const sources = (value.sources ?? []).filter((url) => suppliedUrls.has(url)).slice(0, 5); if (sources.length) return { kind: "operator", objective: value.objective?.trim() || original, sources }; }
  if (value.kind === "clarify" && value.message?.trim()) return { kind: "clarify", message: value.message.trim() };
  return planUnifiedTask(original);
}

export async function planTask(ownerId: string, prompt: string, attachments: GeminiAttachment[] = []): Promise<{ plan: UnifiedPlan; mode: "model" | "deterministic"; fallback_reason: string | null }> {
  const fallback = planUnifiedTask(prompt);
  if (fallback.kind === "offer_search") return { plan: fallback, mode: "deterministic", fallback_reason: "Offer ranking is deterministic and runs outside the model." };
  if (/\b(pay|send|transfer|buy|order|purchase|checkout|trade|swap|escrow|vault|session)\b/i.test(prompt)) {
    return { plan: fallback, mode: "deterministic", fallback_reason: "Financial intents are routed and validated outside the model." };
  }
  if (!geminiConfigured()) return { plan: fallback, mode: "deterministic", fallback_reason: "Gemini API key is not configured." };
  try {
    const proposed = await generateGeminiJson<ModelPlan>({
      ownerId,
      system: "You are the DONADS routing planner. Select only one supported route. Route image or PDF analysis to Scout. Scout otherwise requires public source URLs. Operator is only for a sourced research-plus-campaign task. Sentinel requires supplied EVM bytecode. Growth creates drafts only. Never authorize payments, change transaction values, claim purchases, or bypass deterministic policy. Ask one concise clarification when required inputs are missing.",
      prompt,
      schema,
      attachments,
    });
    return proposed ? { plan: validateModelPlan(proposed, prompt), mode: "model", fallback_reason: null } : { plan: fallback, mode: "deterministic", fallback_reason: "Gemini API key is not configured." };
  } catch (error) {
    return { plan: fallback, mode: "deterministic", fallback_reason: error instanceof Error ? error.message : "Gemini was unavailable." };
  }
}
