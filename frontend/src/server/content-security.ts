import { createHash } from "node:crypto";

export type ContentSecurityScreen = {
  passed: boolean;
  signals: string[];
  content_hash: string;
  source_url: string;
  sanitized_content: string;
};

const SIGNALS = [
  { id: "OVERRIDE_PREVIOUS_INSTRUCTIONS", pattern: /\b(?:ignore previous instructions|ignore all prior instructions|disregard safety)\b/gi },
  { id: "PROMPT_ROLE_HIJACK", pattern: /\b(?:system prompt|you are now|developer mode)\b/gi },
  { id: "UNSOLICITED_MON_TRANSFER", pattern: /\b(?:send|transfer)\b[^.\n]{0,120}\b(?:mon\s+to|to)\s+0x[a-fA-F0-9]{40}\b/gi },
  { id: "UNSOLICITED_APPROVAL", pattern: /\bapprove\s+0x[a-fA-F0-9]{40}\b/gi },
  { id: "SEED_PHRASE_HARVEST", pattern: /\benter your seed phrase\b/gi },
  { id: "PRIVATE_KEY_HARVEST", pattern: /\bprivate key required\b/gi },
] as const;

export function scanFetchedContentForInjection(content: string, sourceUrl: string): ContentSecurityScreen {
  const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
  const signals: string[] = [];
  let sanitizedContent = content;
  for (const signal of SIGNALS) {
    signal.pattern.lastIndex = 0;
    if (signal.pattern.test(content)) signals.push(signal.id);
    signal.pattern.lastIndex = 0;
    sanitizedContent = sanitizedContent.replace(signal.pattern, "[neutralized indirect instruction]");
  }
  return {
    passed: signals.length === 0,
    signals,
    content_hash: `sha256:${contentHash}`,
    source_url: sourceUrl,
    sanitized_content: sanitizedContent,
  };
}
