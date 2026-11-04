export type UnifiedPlan =
  | { kind: "scout"; prompt: string }
  | { kind: "sentinel"; bytecode: string }
  | { kind: "growth"; objective: string }
  | { kind: "operator"; objective: string; sources: string[] }
  | { kind: "flow"; recipient: string; amount: string; purpose: string; asset: "MON"; tokenContract: null }
  | { kind: "flow"; recipient: string; amount: string; purpose: string; asset: string; tokenContract: string }
  | { kind: "flow_batch"; recipients: string[]; amountEach: string; purpose: string }
  | { kind: "swap"; amount: string; inputAsset: string; tokenIn: string; outputAsset: string; tokenOut: string; slippageBps: number; maxPriceImpactBps: number }
  | { kind: "vault_deploy" }
  | { kind: "session_configure"; sessionKey: string; vault: string; recipient: string; perTransaction: string; daily: string; durationHours: number }
  | { kind: "session_revoke"; sessionKey: string; vault: string }
  | { kind: "escrow_create"; amount: string; seller: string; arbiter: string; refundHours: number; terms: string }
  | { kind: "escrow_verify"; escrow: string; deliverableUrl: string }
  | { kind: "escrow_action"; escrow: string; action: "release" | "cooperative_refund" | "timeout_refund" | "dispute" | "resolve_seller" | "resolve_buyer"; evidence: string | null }
  | { kind: "offer_search"; item: string; category: string | null; maxMon: string | null }
  | { kind: "clarify"; message: string };

import { matchCategory, offerCategories } from "@/lib/offers";

function urlsIn(value: string): string[] {
  return [...new Set(value.match(/https?:\/\/[^\s<>"']+/gi)?.map((url) => url.replace(/[),.;!?]+$/g, "")) ?? [])];
}

const MONAD_DEVELOPER_SOURCES = {
  overview: "https://docs.monad.xyz/introduction/monad-for-developers",
  network: "https://docs.monad.xyz/developer-essentials/network-information",
  rpc: "https://docs.monad.xyz/reference/json-rpc/api",
} as const;

function monadDeveloperResearchPrompt(prompt: string): string | null {
  if (!/\bmonad\b/i.test(prompt) || !/(?:\bwhat\b|\bwhy\b|\bhow\b|\bexplain\b|\bresearch\b|\bsummari[sz]e\b|\bdocs?\b|\bdeveloper\b|\brpc\b|\bnetwork\b|\bchain\b|\barchitecture\b|\bgas\b|\bblock\b|\bfinality\b|\bthroughput\b|\btestnet\b|\bmainnet\b)/i.test(prompt)) return null;
  const sources: string[] = [MONAD_DEVELOPER_SOURCES.overview];
  if (/\b(?:network|chain|testnet|mainnet|block|gas|token|explorer)\b/i.test(prompt)) sources.push(MONAD_DEVELOPER_SOURCES.network);
  if (/\b(?:api|rpc|method|developer|transaction|receipt|log|event|websocket)\b/i.test(prompt)) sources.push(MONAD_DEVELOPER_SOURCES.rpc);
  return `${prompt}\n\nUse these official Monad developer sources as primary evidence:\n${[...new Set(sources)].join("\n")}`;
}

const FINANCIAL_WORDS = /\b(?:pay|send|transfer|swap|trade|escrow|vault|session|approve|withdraw)\b/i;

/**
 * Detects text that carries instructions the user did not type themselves:
 * prompt-override phrases, hidden HTML comments, invisible characters, and
 * encoded payloads (Morse, base64). A financial request containing any of
 * these is refused instead of being turned into a transaction intent.
 */
export function hiddenInstructionMarker(text: string): string | null {
  if (/\b(?:ignore|disregard)\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|messages|rules)\b|\bdisregard\s+safety\b/i.test(text)) return "an instruction to ignore earlier instructions";
  if (/\b(?:system prompt|you are now|developer mode|new instructions)\b/i.test(text)) return "an attempt to change the assistant's instructions";
  if (/<!--[\s\S]*?-->|<\s*(?:script|style)\b/i.test(text)) return "hidden markup";
  if (/[​-‏‪-‮⁠-⁤﻿]/.test(text)) return "invisible characters";
  // Morse: runs of dot/dash groups, with "/" commonly used between words.
  if (/(?:^|\s)(?:[.\-/]{1,7}\s+){6,}[.\-/]{1,7}(?=\s|$)/.test(text)) return "Morse-encoded text";
  const encoded = text.match(/[A-Za-z0-9+/]{32,}={0,2}/g)?.find((token) => !/^0x[0-9a-f]+$/i.test(token) && !/^[0-9a-f]+$/i.test(token) && /[A-Z]/.test(token) && /[a-z]/.test(token));
  if (encoded) return "an encoded payload";
  return null;
}

export function planUnifiedTask(rawPrompt: string): UnifiedPlan {
  const injection = hiddenInstructionMarker(rawPrompt);
  if (injection && FINANCIAL_WORDS.test(rawPrompt)) {
    return { kind: "clarify", message: `DONADS did not prepare any payment: this message contains ${injection}. Type the payment yourself in one plain sentence, for example ‘Send 0.01 MON to 0x…’.` };
  }
  const prompt = rawPrompt.trim();
  const lower = prompt.toLowerCase();
  const urls = urlsIn(prompt);
  const bytecode = prompt.match(/0x[0-9a-fA-F]{4,}/)?.[0];
  const recipient = prompt.match(/\b0x[0-9a-fA-F]{40}\b/)?.[0];
  const recipients = [...new Set(prompt.match(/\b0x[0-9a-fA-F]{40}\b/g)?.map((value) => value.toLowerCase()) ?? [])];
  // Normalize common ways users refer to Monad's native asset. The resulting
  // plan always uses the canonical symbol MON; amount/address validation stays
  // deterministic and unchanged.
  const amount = prompt.match(/\b(\d+(?:\.\d{1,18})?)\s*(?:MON|MONS|MONAD|MONADS|MONT|MONTS)\b/i)?.[1];
  const batchAmount = prompt.match(/\b(?:send|pay|transfer)\s+(\d+(?:\.\d{1,18})?)\s*(?:MON|MONS|MONAD|MONADS|MONT|MONTS)\s+(?:to\s+each(?:\s+of)?|each\s+to)\b/i)?.[1];
  const tokenTransfer = prompt.match(/\b(?:send|pay|transfer)\s+(\d+(?:\.\d+)?)\s+([A-Za-z][A-Za-z0-9._-]{0,15})\s+(?:token|contract)\s+(0x[0-9a-fA-F]{40})\s+to\s+(0x[0-9a-fA-F]{40})\b/i);
  const swap = prompt.match(/\bswap\s+(\d+(?:\.\d+)?)\s+([A-Za-z][A-Za-z0-9._-]{0,15})\s+token\s+(0x[0-9a-fA-F]{40})\s+for\s+([A-Za-z][A-Za-z0-9._-]{0,15})\s+token\s+(0x[0-9a-fA-F]{40})(?:\s+(?:with\s+)?max(?:imum)?\s+(\d+(?:\.\d{1,2})?)%\s+slippage)?/i);
  const escrow = prompt.match(/\bcreate\s+escrow\s+(\d+(?:\.\d{1,18})?)\s+MON\s+for\s+(0x[0-9a-fA-F]{40})\s+with\s+arbiter\s+(0x[0-9a-fA-F]{40})\s+refund\s+after\s+(\d{1,4})\s+hours?\s+terms\s+(.{3,500})$/i);
  const configureSession = prompt.match(/\ballow\s+session\s+(0x[0-9a-fA-F]{40})\s+on\s+vault\s+(0x[0-9a-fA-F]{40})\s+to\s+send\s+up\s+to\s+(\d+(?:\.\d{1,18})?)\s+MON\s+per\s+transaction\s+and\s+(\d+(?:\.\d{1,18})?)\s+MON\s+per\s+day\s+for\s+(\d{1,4})\s+hours?\s+to\s+(0x[0-9a-fA-F]{40})/i);
  const revokeSession = prompt.match(/\brevoke\s+session\s+(0x[0-9a-fA-F]{40})\s+on\s+vault\s+(0x[0-9a-fA-F]{40})/i);
  const escrowAddress = prompt.match(/\bescrow\s+(0x[0-9a-fA-F]{40})\b/i)?.[1];
  const verifyEscrow = prompt.match(/\bverify\s+escrow\s+(0x[0-9a-fA-F]{40})\s+with\s+deliverable\s+(https?:\/\/[^\s<>"']+)/i);
  const monadResearchPrompt = urls.length ? null : monadDeveloperResearchPrompt(prompt);

  if (!prompt) return { kind: "clarify", message: "Describe the outcome you want DONADS to complete." };
  if (/\bdeploy\s+(?:my\s+)?policy\s+vault\b/i.test(prompt)) return { kind: "vault_deploy" };
  const offerSearch = prompt.match(/\b(?:find|show|get)\s+(?:me\s+)?(?:the\s+)?best\s+offers?\s+for\s+(?:an?\s+)?(.+?)(?:\s+(?:under|below|max(?:imum)?|up\s+to)\s+(\d+(?:\.\d{1,18})?)\s*MON)?[.!?]*$/i);
  if (offerSearch) {
    const item = offerSearch[1].trim();
    const category = matchCategory(item);
    if (!category) return { kind: "clarify", message: `I can rank test-seller offers for: ${offerCategories().join(", ")}. Try ‘Find the best offer for a logo design under 0.05 MON’.` };
    return { kind: "offer_search", item, category, maxMon: offerSearch[2] ?? null };
  }
  if (escrow) return { kind: "escrow_create", amount: escrow[1], seller: escrow[2], arbiter: escrow[3], refundHours: Number(escrow[4]), terms: escrow[5].trim() };
  if (verifyEscrow) return { kind: "escrow_verify", escrow: verifyEscrow[1], deliverableUrl: verifyEscrow[2].replace(/[),.;!?]+$/g, "") };
  if (escrowAddress && /\brelease\s+escrow\b/i.test(prompt)) return { kind: "escrow_action", escrow: escrowAddress, action: "release", evidence: null };
  if (escrowAddress && /\bcooperative\s+refund\s+escrow\b/i.test(prompt)) return { kind: "escrow_action", escrow: escrowAddress, action: "cooperative_refund", evidence: null };
  if (escrowAddress && /\btimeout\s+refund\s+escrow\b/i.test(prompt)) return { kind: "escrow_action", escrow: escrowAddress, action: "timeout_refund", evidence: null };
  if (escrowAddress && /\bdispute\s+escrow\b/i.test(prompt)) return { kind: "escrow_action", escrow: escrowAddress, action: "dispute", evidence: prompt.match(/\bevidence\s+(.{3,500})$/i)?.[1].trim() ?? null };
  if (escrowAddress && /\bresolve\s+escrow\b/i.test(prompt) && /\bto\s+(?:seller|buyer)\b/i.test(prompt)) return { kind: "escrow_action", escrow: escrowAddress, action: /\bto\s+seller\b/i.test(prompt) ? "resolve_seller" : "resolve_buyer", evidence: prompt.match(/\bresolution\s+(.{3,500})$/i)?.[1].trim() ?? null };
  if (configureSession) return { kind: "session_configure", sessionKey: configureSession[1], vault: configureSession[2], perTransaction: configureSession[3], daily: configureSession[4], durationHours: Number(configureSession[5]), recipient: configureSession[6] };
  if (revokeSession) return { kind: "session_revoke", sessionKey: revokeSession[1], vault: revokeSession[2] };
  if (/\bescrow\b/i.test(prompt)) return { kind: "clarify", message: "Use: ‘Create escrow 1 MON for 0xSELLER with arbiter 0xARBITER refund after 24 hours terms Product delivered as agreed’." };
  if (/\b(?:policy vault|session permission|session key)\b/i.test(prompt)) return { kind: "clarify", message: "Deploy with ‘Deploy my policy vault’. Then configure an externally secured session address with: ‘Allow session 0xSESSION on vault 0xVAULT to send up to 0.1 MON per transaction and 1 MON per day for 24 hours to 0xRECIPIENT’." };
  if (bytecode && /(audit|scan|bytecode|security|risk)/i.test(prompt)) return { kind: "sentinel", bytecode };

  const isCampaign = /(campaign|marketing|launch|content|posts?|growth|social)/i.test(prompt);
  if (isCampaign && urls.length) return { kind: "operator", objective: prompt, sources: urls.slice(0, 5) };
  if (isCampaign) return { kind: "growth", objective: prompt };
  if (monadResearchPrompt) return { kind: "scout", prompt: monadResearchPrompt };
  if (urls.length || /(research|compare|investigate|summari[sz]e|find out)/i.test(prompt)) {
    if (!urls.length) return { kind: "clarify", message: "Add at least one public source URL so Scout can produce cited, verifiable research." };
    return { kind: "scout", prompt };
  }
  if (/(buy|order|purchase|checkout)/i.test(prompt)) {
    return { kind: "clarify", message: "Send the exact crypto-accepting product or checkout URL, asset, maximum budget, and delivery country. Commerce will verify the offer before asking for approval." };
  }
  if (/(trade|swap)/i.test(prompt)) {
    if (swap) return { kind: "swap", amount: swap[1], inputAsset: swap[2].toUpperCase(), tokenIn: swap[3], outputAsset: swap[4].toUpperCase(), tokenOut: swap[5], slippageBps: swap[6] ? Math.round(Number(swap[6]) * 100) : 50, maxPriceImpactBps: 200 };
    return { kind: "clarify", message: "Use: ‘Swap 1 USDC token 0xINPUT for DAI token 0xOUTPUT max 0.5% slippage’. Flow will query only the allowlisted Uniswap v3 Monad Testnet adapter and block quotes above policy." };
  }
  if (/(pay|send|transfer)/i.test(prompt)) {
    if (!tokenTransfer && recipients.length > 1) {
      if (!batchAmount) return { kind: "clarify", message: "For multiple recipients, state the per-recipient amount explicitly: ‘Send 0.01 MON to each of 0xA, 0xB, 0xC’. This prevents confusing a total with an amount per wallet." };
      if (recipients.length > 10) return { kind: "clarify", message: "A reviewed batch supports up to 10 unique recipients. Split larger distributions into separate batches." };
      return { kind: "flow_batch", recipients, amountEach: batchAmount, purpose: prompt };
    }
    if (tokenTransfer) return { kind: "flow", amount: tokenTransfer[1], asset: tokenTransfer[2].toUpperCase(), tokenContract: tokenTransfer[3], recipient: tokenTransfer[4], purpose: prompt };
    if (recipient && amount) return { kind: "flow", recipient, amount, purpose: prompt, asset: "MON", tokenContract: null };
    return { kind: "clarify", message: "For MON: ‘Send 0.01 MON to 0x…’. For a token: ‘Send 10 USDC token 0xTOKEN_CONTRACT to 0xRECIPIENT’. Flow validates the exact contract before wallet approval." };
  }
  if (lower.length < 12) return { kind: "clarify", message: "Tell me the target outcome and any source URLs or constraints that matter." };
  return { kind: "clarify", message: "I can route cited research, campaign creation, contract bytecode scans, crypto purchases, and Monad payments. Add the concrete target and required inputs." };
}
