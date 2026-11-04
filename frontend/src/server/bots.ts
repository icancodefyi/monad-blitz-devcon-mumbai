import { decodeFunctionResult, encodeFunctionData, formatEther, getAddress, isAddress, keccak256, stringToHex } from "viem";

import type {
  CommerceCompletedTask,
  CommerceOffer,
  FlowCompletedTask,
  GrowthCompletedTask,
  OperatorCompletedTask,
  OperatorTaskInput,
  ScoutCompletedTask,
  SentinelCompletedTask,
} from "@/lib/donads-api";
import { DonadsEscrowAbi, DonadsEscrowDeployedBytecode, DonadsEscrowImmutableReferences } from "@/contracts/generated";
import { scanFetchedContentForInjection } from "@/server/content-security";
import { generateGeminiJson } from "@/server/gemini";
import { monadRpc, readErc20Balance, readErc20Metadata, tokenAmountToAtomic } from "@/server/monad";
import { fetchPublicText } from "@/server/public-web";
import { assessThreat } from "@/server/threat-intelligence";

type RecordValue = Record<string, unknown>;
type CompletedStatus =
  | ScoutCompletedTask["status"]
  | GrowthCompletedTask["status"]
  | FlowCompletedTask["status"]
  | CommerceCompletedTask["status"]
  | OperatorCompletedTask["status"]
  | SentinelCompletedTask["status"];

function object(value: unknown, label = "input"): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as RecordValue;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`${label} must be a string array.`);
  return value;
}

function parseBytecode(value: unknown): Uint8Array {
  const source = text(value, "bytecode").replace(/^0x/i, "");
  if (!source || source.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(source)) throw new Error("Bytecode must be non-empty, even-length hexadecimal.");
  return Uint8Array.from(source.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));
}

function sentinel(input: unknown, started: number): SentinelCompletedTask["status"] {
  const bytes = parseBytecode(object(input).bytecode);
  const signals = new Map<number, { id: string; severity: string; title: string }>([
    [0xff, { id: "SELFDESTRUCT_REACHABLE", severity: "high", title: "Reachable SELFDESTRUCT opcode" }],
    [0xf4, { id: "DELEGATECALL_REACHABLE", severity: "medium", title: "Reachable DELEGATECALL opcode" }],
    [0xf2, { id: "CALLCODE_REACHABLE", severity: "medium", title: "Reachable CALLCODE opcode" }],
    [0x32, { id: "TX_ORIGIN_USED", severity: "low", title: "ORIGIN opcode is present" }],
  ]);
  const findings: SentinelCompletedTask["status"]["data"]["findings"] = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    const opcode = bytes[cursor];
    const signal = signals.get(opcode);
    if (signal && !findings.some((finding) => finding.id === signal.id)) {
      findings.push({ ...signal, evidence: `Opcode 0x${opcode.toString(16).padStart(2, "0")} at byte offset ${cursor}.` });
    }
    cursor += opcode >= 0x60 && opcode <= 0x7f ? opcode - 0x5f + 1 : 1;
  }
  const score = Math.min(100, findings.reduce((total, finding) => total + (finding.severity === "high" ? 60 : finding.severity === "medium" ? 30 : 10), 0));
  return {
    state: "completed",
    summary: findings.length ? `Sentinel found ${findings.length} high-confidence risk signal(s); threat score ${score}/100.` : "Sentinel found no high-confidence opcode signals; threat score 0/100.",
    data: { threat_score: score, bytecode_bytes: bytes.length, findings, scope: "Executable EVM bytecode only", disclaimer: "Deterministic opcode triage is not a complete smart-contract audit." },
    latency_ms: Date.now() - started,
  };
}

async function fetchPublicSource(source: string): Promise<{ url: string; title: string; body: string }> {
  const preflight = assessThreat({ text: source, urls: [source] });
  if (preflight.blocked) throw new Error(`Sentinel blocked this source before retrieval: ${preflight.findings.map((finding) => finding.code).join(", ")}.`);
  const fetched = await fetchPublicText(source);
  const finalPreflight = assessThreat({ text: fetched.url, urls: [fetched.url] });
  if (finalPreflight.blocked) throw new Error(`Sentinel blocked the final source: ${finalPreflight.findings.map((finding) => finding.code).join(", ")}.`);
  return fetched;
}

function matchesDonadsEscrowRuntime(code: string): boolean {
  const actual = code.toLowerCase().replace(/^0x/, "").split("");
  const expected = DonadsEscrowDeployedBytecode.toLowerCase().replace(/^0x/, "").split("");
  if (actual.length !== expected.length) return false;
  for (const references of Object.values(DonadsEscrowImmutableReferences)) {
    for (const reference of references) {
      const start = reference.start * 2;
      const end = start + reference.length * 2;
      actual.fill("0", start, end);
      expected.fill("0", start, end);
    }
  }
  return actual.join("") === expected.join("");
}

async function prepareDeliverableVerification(args: {
  escrowAddress: string;
  ownerId: string;
  deliverableUrl: string;
  source: ScoutCompletedTask["status"]["data"]["report"]["sources"][number];
  extractedSummary: string;
}): Promise<NonNullable<ScoutCompletedTask["status"]["data"]["deliverableVerification"]>> {
  const escrowAddress = getAddress(args.escrowAddress).toLowerCase();
  const retrievedAt = args.source.retrievedAt ?? new Date().toISOString();
  const signals = args.source.securityScreen?.signals ?? (args.source.status === "failed" ? ["SOURCE_RETRIEVAL_FAILED"] : []);
  const clean = args.source.status === "fetched" && args.source.securityScreen?.passed === true;
  const evidence = [
    `Deliverable ${args.deliverableUrl}`,
    `retrieved ${retrievedAt}`,
    args.source.contentHash ?? `error ${args.source.error ?? "unavailable"}`,
    `Sentinel ${clean ? "CLEAN" : signals.join(",") || "BLOCKED"}`,
  ].join(" | ").slice(0, 500);

  const code = String(await monadRpc("eth_getCode", [escrowAddress, "latest"]));
  if (!code || code === "0x" || code === "0x0") {
    return {
      escrowAddress, deliverableUrl: args.deliverableUrl, contentHash: args.source.contentHash ?? null, retrievedAt,
      sentinelVerdict: { verdict: clean ? "CLEAN" : "BLOCKED", threatScore: clean ? 0 : 100, signals },
      extractedSummary: args.extractedSummary, onchain: null, recommendedAction: "none", actionCalldata: null, evidence,
      blockedReason: "The supplied escrow address has no contract bytecode on Monad Testnet. No financial action was prepared.",
    };
  }
  if (!matchesDonadsEscrowRuntime(code)) {
    return {
      escrowAddress, deliverableUrl: args.deliverableUrl, contentHash: args.source.contentHash ?? null, retrievedAt,
      sentinelVerdict: { verdict: "BLOCKED", threatScore: 100, signals: [...signals, "UNVERIFIED_ESCROW_RUNTIME"] },
      extractedSummary: args.extractedSummary, onchain: null, recommendedAction: "none", actionCalldata: null, evidence,
      blockedReason: "The contract runtime does not match the compiled DONADS escrow template. No financial action was prepared.",
    };
  }

  async function read(functionName: "state" | "termsHash" | "buyer" | "seller" | "fundedAmount") {
    const data = encodeFunctionData({ abi: DonadsEscrowAbi, functionName });
    const result = String(await monadRpc("eth_call", [{ to: escrowAddress, data }, "latest"])) as `0x${string}`;
    return decodeFunctionResult({ abi: DonadsEscrowAbi, functionName, data: result });
  }
  const [stateValue, termsHashValue, buyerValue, sellerValue, fundedAmountValue] = await Promise.all([
    read("state"), read("termsHash"), read("buyer"), read("seller"), read("fundedAmount"),
  ]);
  const state = Number(stateValue);
  const buyer = String(buyerValue).toLowerCase();
  const seller = String(sellerValue).toLowerCase();
  const owner = args.ownerId.toLowerCase();
  let recommendedAction: "release" | "dispute" | "none" = clean ? "release" : "dispute";
  let blockedReason: string | null = null;
  if (state !== 0) {
    recommendedAction = "none";
    blockedReason = `Escrow state is ${state}, not Funded (0). No release or dispute action was prepared.`;
  } else if (recommendedAction === "release" && owner !== buyer) {
    recommendedAction = "none";
    blockedReason = "Only the on-chain buyer can release this escrow; the connected wallet does not match the buyer.";
  } else if (recommendedAction === "dispute" && owner !== buyer && owner !== seller) {
    recommendedAction = "none";
    blockedReason = "Only the on-chain buyer or seller can dispute this escrow; the connected wallet is neither party.";
  }
  const actionCalldata = recommendedAction === "release"
    ? encodeFunctionData({ abi: DonadsEscrowAbi, functionName: "release" })
    : recommendedAction === "dispute"
      ? encodeFunctionData({ abi: DonadsEscrowAbi, functionName: "raiseDispute", args: [keccak256(stringToHex(evidence))] })
      : null;

  return {
    escrowAddress, deliverableUrl: args.deliverableUrl, contentHash: args.source.contentHash ?? null, retrievedAt,
    sentinelVerdict: { verdict: clean ? "CLEAN" : "BLOCKED", threatScore: clean ? 0 : 100, signals },
    extractedSummary: args.extractedSummary,
    onchain: { contractCodeHash: keccak256(code as `0x${string}`), state, termsHash: String(termsHashValue), buyer, seller, fundedAmountAtomic: String(fundedAmountValue) },
    recommendedAction, actionCalldata, evidence, blockedReason,
  };
}

async function scout(input: unknown, started: number, ownerId?: string): Promise<ScoutCompletedTask["status"]> {
  const scoutInput = object(input);
  const query = typeof scoutInput.query === "string" && scoutInput.query.trim() ? scoutInput.query.trim().slice(0, 4_000) : "Identify the most decision-relevant facts in the supplied evidence.";
  const sources = stringArray(scoutInput.sources ?? [], "sources").slice(0, 5);
  const attachments = Array.isArray(scoutInput.attachments) ? scoutInput.attachments.map((value) => {
    const item = object(value, "attachment");
    return { name: text(item.name, "attachment.name"), mimeType: text(item.mime_type, "attachment.mime_type"), data: text(item.data, "attachment.data") };
  }) : [];
  if (!sources.length && !attachments.length) throw new Error("Scout requires a public source URL or an AI-readable attachment.");
  const escrowAddress = typeof scoutInput.escrow_address === "string" ? scoutInput.escrow_address.trim() : "";
  if (escrowAddress && (!ownerId || !isAddress(escrowAddress) || sources.length !== 1)) throw new Error("Deliverable verification requires one valid escrow address, one public URL, and an authenticated wallet.");
  const reportSources: ScoutCompletedTask["status"]["data"]["report"]["sources"] = [];
  const findings: ScoutCompletedTask["status"]["data"]["report"]["findings"] = [];
  await Promise.all(sources.map(async (source, index) => {
    try {
      const fetched = await fetchPublicSource(source);
      if (fetched.body.trim().length < 20) throw new Error("Source did not contain enough readable text to verify.");
      const retrievedAt = new Date().toISOString();
      const screen = scanFetchedContentForInjection(fetched.body, fetched.url);
      reportSources[index] = { id: index + 1, title: fetched.title, url: fetched.url, status: "fetched", error: null, contentHash: screen.content_hash, retrievedAt, securityScreen: { passed: screen.passed, signals: screen.signals, contentHash: screen.content_hash } };
      if (screen.passed) findings[index] = { text: screen.sanitized_content.slice(0, 500) || "The source did not contain readable text.", citations: [index + 1] };
    } catch (cause) {
      reportSources[index] = { id: index + 1, title: "Source unavailable", url: source, status: "failed", error: cause instanceof Error ? cause.message : "Fetch failed.", contentHash: null, retrievedAt: new Date().toISOString(), securityScreen: { passed: false, signals: ["SOURCE_RETRIEVAL_FAILED"], contentHash: null } };
    }
  }));
  attachments.forEach((attachment, index) => { reportSources.push({ id: sources.length + index + 1, title: attachment.name, url: `attachment:${encodeURIComponent(attachment.name)}`, status: "fetched", error: null }); });
  let validFindings = findings.filter(Boolean);
  if (ownerId && (validFindings.length || attachments.length)) {
    try {
      const enhanced = await generateGeminiJson<{ findings: Array<{ text: string; citations: number[] }> }>({
        ownerId,
        system: "Answer the user's exact question using only the supplied evidence. Return 3-6 non-overlapping, decision-relevant findings when the evidence permits. Start each finding with a direct factual conclusion; preserve concrete names, values, limits, methods, and caveats. Every finding must cite one or more valid source IDs. Never add outside facts or URLs, repeat the request, describe your process, use promotional filler, or return generic advice. If the evidence does not answer part of the question, say exactly what is missing.",
        prompt: JSON.stringify({ question: query, sources: reportSources.map((source, index) => ({ id: source.id, title: source.title, excerpt: findings[index]?.text ?? "Analyze the attached file and cite this source ID." })) }),
        schema: { type: "object", properties: { findings: { type: "array", items: { type: "object", properties: { text: { type: "string" }, citations: { type: "array", items: { type: "integer" } } }, required: ["text", "citations"], additionalProperties: false } } }, required: ["findings"], additionalProperties: false },
        attachments,
      });
      const validIds = new Set(reportSources.filter((source) => source.status === "fetched" && source.securityScreen?.passed !== false).map((source) => source.id));
      const checked = enhanced?.findings.filter((finding) => finding.text.trim() && finding.citations.length && finding.citations.every((id) => validIds.has(id)));
      if (checked?.length) validFindings = checked;
    } catch { /* Deterministic cited excerpts remain the fail-closed fallback. */ }
  }
  if (!validFindings.length && attachments.length) throw new Error("Scout could not analyze the attachment. Check the Gemini key, quota, and file format, then retry.");
  const webScreens = reportSources.filter((source) => source.url.startsWith("http") && source.securityScreen).map((source) => source.securityScreen!);
  const securityScreen = { passed: webScreens.every((screen) => screen.passed), signals: [...new Set(webScreens.flatMap((screen) => screen.signals))], contentHash: webScreens.length === 1 ? webScreens[0].contentHash : null };
  const deliverableVerification = escrowAddress
    ? await prepareDeliverableVerification({ escrowAddress, ownerId: ownerId!, deliverableUrl: sources[0], source: reportSources[0], extractedSummary: validFindings[0]?.text ?? reportSources[0].error ?? "Deliverable could not be verified." })
    : undefined;
  const flagged = securityScreen.signals.length;
  return { state: "completed", summary: flagged ? `Scout reviewed the supplied sources and Sentinel neutralized ${flagged} security signal(s).` : `Scout reviewed ${reportSources.filter((source) => source.status === "fetched").length}/${sources.length} supplied sources and produced ${validFindings.length} cited finding(s).`, data: { report: { title: "Source-linked research report", findings: validFindings, sources: reportSources, limitations: "Scout summarizes only supplied public sources after deterministic security screening. Verify important claims in the originals." }, agent_version: "scout-vercel-v2", read_only: true, securityScreen, ...(deliverableVerification ? { deliverableVerification } : {}) }, latency_ms: Date.now() - started };
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(value.getTime())) throw new Error("start_date must be a valid ISO date.");
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

async function growth(input: unknown, started: number, ownerId?: string): Promise<GrowthCompletedTask["status"]> {
  const data = object(input);
  const profile = object(data.profile, "profile");
  const project = text(profile.project_name, "profile.project_name");
  const objective = text(data.objective, "objective");
  const audience = text(profile.target_audience, "profile.target_audience");
  const tone = text(profile.preferred_tone, "profile.preferred_tone");
  const pillars = stringArray(profile.value_propositions, "profile.value_propositions");
  if (!pillars.length) throw new Error("At least one value proposition is required.");
  const platforms = stringArray(data.platforms, "platforms") as Array<"x" | "linkedin" | "community" | "email">;
  if (!platforms.length) throw new Error("At least one platform is required.");
  const duration = Math.min(30, Math.max(1, Number(data.duration_days)));
  const startDate = text(data.start_date, "start_date");
  const approvedLinks = stringArray(profile.approved_links ?? [], "profile.approved_links");
  const calendar = Array.from({ length: duration }, (_, index) => {
    const platform = platforms[index % platforms.length];
    const pillar = pillars[index % pillars.length];
    return { day: index + 1, date: addDays(startDate, index), platform, format: platform === "email" ? "Email brief" : "Short post", objective: index === 0 ? "Introduce the objective" : "Build evidence and understanding", draft: `${project}: ${pillar}. ${objective}. Built for ${audience}.`, call_to_action: "Review the cited material and share feedback.", visual_asset: `One ${tone} product visual for ${platform}.`, status: "draft" as const, evidence_urls: approvedLinks };
  });
  if (ownerId) {
    try {
      const enhanced = await generateGeminiJson<{ drafts: Array<{ day: number; draft: string; call_to_action: string }> }>({
        ownerId,
        system: "Improve campaign drafts using only the supplied brief. Preserve each day number. Return reviewable drafts only; never claim publishing, transactions, endorsements, or unverifiable results. Avoid prohibited terms.",
        prompt: JSON.stringify({ project, objective, audience, tone, pillars, prohibited_terms: profile.prohibited_terms ?? [], calendar }),
        schema: { type: "object", properties: { drafts: { type: "array", maxItems: duration, items: { type: "object", properties: { day: { type: "integer" }, draft: { type: "string" }, call_to_action: { type: "string" } }, required: ["day", "draft", "call_to_action"], additionalProperties: false } } }, required: ["drafts"], additionalProperties: false },
      });
      for (const draft of enhanced?.drafts ?? []) { const target = calendar.find((item) => item.day === draft.day); if (target && draft.draft.trim()) { target.draft = draft.draft.trim(); target.call_to_action = draft.call_to_action.trim() || target.call_to_action; } }
    } catch { /* Template drafts remain available when the model is unavailable. */ }
  }
  return { state: "completed", summary: `Growth prepared ${calendar.length} reviewable draft(s); no content was published.`, data: { campaign: { project_name: project, objective, target_audience: audience, tone, message_pillars: pillars, calendar, required_asset_count: calendar.length, restrictions_applied: stringArray(profile.prohibited_terms ?? [], "profile.prohibited_terms"), status: "draft", publishing: "disabled" }, agent_version: "growth-vercel-v1", external_actions: false }, latency_ms: Date.now() - started };
}

function decimalAmount(value: unknown): string {
  const amount = text(value, "amount");
  if (!/^\d+(?:\.\d{1,18})?$/.test(amount) || Number(amount) <= 0) throw new Error("MON amount must be positive with at most 18 decimal places.");
  return amount;
}

async function flow(input: unknown, started: number): Promise<FlowCompletedTask["status"]> {
  const data = object(input);
  const payer = text(data.payer, "payer");
  if (!isAddress(payer)) throw new Error("payer must be a valid EVM address.");
  if (!Array.isArray(data.payouts) || !data.payouts.length || data.payouts.length > 10) throw new Error("Flow requires between one and ten payouts.");
  const payoutInputs = data.payouts.map((value) => object(value, "payout"));
  const firstPayout = payoutInputs[0];
  const tokenContract = typeof firstPayout.token_contract === "string" ? firstPayout.token_contract.trim() : "";
  if (payoutInputs.length > 1 && tokenContract) throw new Error("Multi-recipient batches currently support native MON only.");
  const token = tokenContract ? await readErc20Metadata(tokenContract) : null;
  if (token && typeof firstPayout.asset === "string" && firstPayout.asset.trim().toUpperCase() !== token.symbol.toUpperCase()) throw new Error(`Token symbol mismatch: contract reports ${token.symbol}.`);
  const normalizedPayouts = payoutInputs.map((payout, index) => {
    const recipient = text(payout.recipient_address, `payouts[${index}].recipient_address`);
    if (!isAddress(recipient)) throw new Error(`payouts[${index}].recipient_address must be a valid EVM address.`);
    const amount = token ? text(payout.amount, `payouts[${index}].amount`) : decimalAmount(payout.amount);
    return { payout, recipient: getAddress(recipient).toLowerCase(), amount };
  });
  if (new Set(normalizedPayouts.map((item) => item.recipient)).size !== normalizedPayouts.length) throw new Error("Batch recipient addresses must be unique.");
  const amount = normalizedPayouts[0].amount;
  const amountAtomic = token ? tokenAmountToAtomic(amount, token.decimals) : null;
  const recipient = normalizedPayouts[0].recipient;
  const [senderBalance, recipientBalance] = token ? await Promise.all([
    readErc20Balance(token.contract, payer),
    readErc20Balance(token.contract, recipient),
  ]) : [null, null];
  if (amountAtomic !== null && senderBalance !== null && senderBalance < amountAtomic) throw new Error(`Insufficient ${token?.symbol} balance for this transfer.`);
  const now = Date.now();
  const asset = token?.symbol ?? "MON";
  const payouts = normalizedPayouts.map(({ payout, recipient, amount }, index) => ({ recipient_name: typeof payout.recipient_name === "string" && payout.recipient_name.trim() ? payout.recipient_name.trim() : `Recipient ${index + 1}`, recipient_address: recipient, asset, amount, milestone: text(payout.milestone, "milestone"), deadline: typeof payout.deadline === "string" ? payout.deadline : null, token_contract: token?.contract ?? null, token_decimals: token?.decimals ?? null, amount_atomic: token ? tokenAmountToAtomic(amount, token.decimals).toString() : null }));
  const totalAtomic = token ? amountAtomic!.toString() : normalizedPayouts.reduce((total, item) => total + monToWei(item.amount), BigInt(0)).toString();
  const totalAmount = token ? amount : formatEther(BigInt(totalAtomic));
  const workflow = { id: crypto.randomUUID(), title: text(data.title, "title"), purpose: text(data.purpose, "purpose"), payer: getAddress(payer).toLowerCase(), network: "Monad Testnet" as const, chain_id: 10143 as const, transfer_kind: token ? "erc20" as const : "native" as const, token: token ? { ...token, sender_balance_before_atomic: senderBalance!.toString(), recipient_balance_before_atomic: recipientBalance!.toString() } : null, state: "awaiting_approval" as const, payouts, totals: [{ asset, amount: totalAmount }], total_atomic: totalAtomic, approval_conditions: stringArray(data.approval_conditions, "approval_conditions"), linked_task_id: typeof data.linked_task_id === "string" ? data.linked_task_id : null, approval: null, submission: null, submissions: [], execution: null, executions: [], audit_history: [{ sequence: 1, event: "intent_created", detail: `Exact Monad Testnet ${asset} ${payouts.length === 1 ? "transfer" : `${payouts.length}-recipient batch`} prepared; no signature requested.`, at_ms: now }] };
  return { state: "completed", summary: `Flow prepared an exact Monad Testnet ${asset} ${payouts.length === 1 ? "transfer" : `batch for ${payouts.length} recipients`} and is waiting for explicit wallet approval.`, data: { workflow, agent_version: "flow-vercel-v3", execution_available: false, blocked_reason: "The user must approve and broadcast every exact transaction in their browser wallet." }, latency_ms: Date.now() - started };
}

function commerce(input: unknown, started: number): CommerceCompletedTask["status"] {
  const data = object(input);
  const asset = text(data.asset, "asset").toUpperCase();
  const budget = BigInt(text(data.budget_atomic, "budget_atomic"));
  if (!Array.isArray(data.offers) || !data.offers.length) throw new Error("At least one merchant offer is required.");
  const offers = data.offers.map((value) => object(value, "offer") as unknown as CommerceOffer).filter((offer) => offer.in_stock && offer.crypto_payment_supported && offer.asset.toUpperCase() === asset && BigInt(offer.total_atomic) <= budget);
  if (!offers.length) throw new Error("No in-stock crypto offer fits the exact asset and budget.");
  offers.sort((left, right) => (BigInt(left.total_atomic) < BigInt(right.total_atomic) ? -1 : 1));
  const selected = offers[0];
  for (const field of [selected.source_url, selected.checkout_url]) {
    const url = new URL(field);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Merchant evidence URLs must use HTTP(S).");
  }
  const now = Date.now();
  const workflow = { id: crypto.randomUUID(), objective: text(data.objective, "objective"), state: "awaiting_approval" as const, selected_offer: selected, alternatives_considered: data.offers.length - 1, budget_atomic: budget.toString(), total_atomic: selected.total_atomic, asset, approval_id: null, approved_at_ms: null, merchant_invoice: null, payment_proof: null, order_receipt: null, audit_history: [{ sequence: 1, event: "offer_selected", detail: "Source-linked crypto offer selected within budget; no order placed.", at_ms: now }] };
  return { state: "completed", summary: "Commerce selected a source-linked crypto offer and is waiting for exact user authorization; no order has been placed.", data: { workflow, agent_version: "commerce-crypto-order-v2", execution_available: false, blocked_reason: "A configured merchant API, invoice, wallet payment, and verified merchant receipt are required to complete an order." }, latency_ms: Date.now() - started };
}

function operator(input: unknown, started: number): OperatorCompletedTask["status"] {
  const data = object(input) as unknown as OperatorTaskInput;
  if (!data.objective?.trim() || !Array.isArray(data.steps) || !data.steps.length) throw new Error("Operator requires an objective and at least one step.");
  const ids = new Set<string>();
  data.steps.forEach((step, index) => {
    if (!step.id || ids.has(step.id)) throw new Error("Operator step IDs must be unique.");
    if (step.depends_on.some((dependency) => !ids.has(dependency))) throw new Error("Each dependency must refer to an earlier step.");
    ids.add(step.id);
    if (!['scout', 'growth', 'flow', 'commerce'].includes(step.bot)) throw new Error(`Unsupported specialist at step ${index + 1}.`);
  });
  const now = Date.now();
  const workflow = { id: crypto.randomUUID(), objective: data.objective.trim(), target_date: data.target_date ?? null, state: "planned" as const, steps: data.steps.map((step, index) => ({ ...step, order: index + 1, status: "pending" as const, task_id: null, summary: null, error: null })), cancellation_requested: false, started_at_ms: null, completed_at_ms: null, audit_history: [{ sequence: 1, event: "plan_created", detail: "Dependency graph validated; execution requires explicit start.", at_ms: now }], permissions: { external_writes: false as const, publishing_available: false as const, signing_available: false as const, fund_movement_available: false as const } };
  return { state: "completed", summary: `Operator prepared ${workflow.steps.length} dependency-validated step(s).`, data: { workflow, agent_version: "operator-orchestration-v2", external_actions: false }, latency_ms: Date.now() - started };
}

export async function executeBot(bot: string, input: unknown, ownerId?: string): Promise<CompletedStatus> {
  const started = Date.now();
  switch (bot) {
    case "scout": return scout(input, started, ownerId);
    case "growth": return growth(input, started, ownerId);
    case "flow": return flow(input, started);
    case "commerce": return commerce(input, started);
    case "operator": return operator(input, started);
    case "sentinel": return sentinel(input, started);
    default: throw new Error(`Unknown specialist: ${bot}.`);
  }
}

export function monToWei(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * BigInt(10) ** BigInt(18) + BigInt(fraction.padEnd(18, "0"));
}
