import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const baseUrl = (process.env.DONADS_ACCEPTANCE_API_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");

async function request(path, init = {}, token = null) {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const payload = response.status === 204 ? null : await response.json();
  return { response, payload };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const account = privateKeyToAccount(generatePrivateKey());
const challenge = await request("/api/v1/auth/challenge", {
  method: "POST",
  body: JSON.stringify({ address: account.address }),
});
assert(challenge.response.status === 201, `Challenge failed: ${JSON.stringify(challenge.payload)}`);

const signature = await account.signMessage({ message: challenge.payload.message });
const verification = await request("/api/v1/auth/verify", {
  method: "POST",
  body: JSON.stringify({ address: account.address, signature }),
});
assert(verification.response.ok, `Verification failed: ${JSON.stringify(verification.payload)}`);
const token = verification.payload.access_token;
const sessionCookie = verification.response.headers.get("set-cookie");
assert(sessionCookie?.includes("donads_session="), "Wallet verification did not set a durable session cookie.");
assert(/HttpOnly/i.test(sessionCookie), "Wallet session cookie is not HttpOnly.");
const restored = await request("/api/v1/auth/session", { headers: { cookie: sessionCookie } });
assert(restored.response.ok && restored.payload.owner_id === account.address.toLowerCase(), "Wallet session did not restore from its secure cookie.");
const balance = await request("/api/v1/wallet/balance", {}, token);
assert(balance.response.ok && balance.payload.chain_id === 10143 && balance.payload.symbol === "MON", "Monad Testnet balance endpoint failed.");
const aiUsage = await request("/api/v1/ai/usage", {}, token);
assert(aiUsage.response.ok && aiUsage.payload.remaining_today >= 0 && aiUsage.payload.remaining_today <= 30, "AI usage endpoint failed.");
const tokenBalances = await request("/api/v1/wallet/token-balances", {}, token);
assert(tokenBalances.response.ok && Array.isArray(tokenBalances.payload), "ERC-20 balance endpoint failed.");
const readiness = await request("/api/v1/readiness/mainnet", {}, token);
assert(readiness.response.ok && readiness.payload.ready === false && readiness.payload.network_enabled === false, "Mainnet readiness gate must remain disabled.");

const unfundedTokenTransfer = await request("/api/v1/tasks", {
  method: "POST",
  body: JSON.stringify({
    prompt: "Validate an unfunded ERC-20 transfer",
    bot: "flow",
    input: {
      title: "ERC-20 acceptance failure",
      purpose: "Verify live token metadata and insufficient-balance blocking",
      payer: account.address,
      payouts: [{ recipient_name: "Acceptance recipient", recipient_address: "0x2222222222222222222222222222222222222222", asset: "USDC", amount: "1", token_contract: "0x534b2f3A21130d7a60830c2Df862319e593943A3", milestone: "Acceptance", deadline: null }],
      approval_conditions: ["Exact token contract and amount reviewed"], linked_task_id: null,
    },
  }),
}, token);
assert(unfundedTokenTransfer.response.status === 201 && unfundedTokenTransfer.payload.status.state === "failed" && /insufficient USDC balance/i.test(unfundedTokenTransfer.payload.status.error), "Live ERC-20 insufficient-balance policy did not fail closed.");

const dexQuote = await request("/api/v1/dex/quote", {
  method: "POST",
  body: JSON.stringify({ token_in: "0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541", token_out: "0x534b2f3A21130d7a60830c2Df862319e593943A3", amount: "0.001", slippage_bps: 50, max_price_impact_bps: 200 }),
}, token);
assert(dexQuote.response.ok || /official Monad Testnet addresses have no bytecode/i.test(dexQuote.payload.error), `DEX adapter returned an unexpected result: ${JSON.stringify(dexQuote.payload)}`);

const created = await request("/api/v1/tasks", {
  method: "POST",
  body: JSON.stringify({ prompt: "Acceptance scan for executable SELFDESTRUCT", bot: "sentinel", input: { bytecode: "0x60ff00ff" } }),
}, token);
assert(created.response.status === 201, `Task creation failed: ${JSON.stringify(created.payload)}`);
assert(created.payload.status.state === "completed", "Sentinel task did not complete.");
assert(created.payload.status.data.findings[0]?.id === "SELFDESTRUCT_REACHABLE", "Expected Sentinel finding was absent.");
const missions = await request("/api/v1/missions?limit=20", {}, token);
assert(missions.response.ok && missions.payload.some((mission) => mission.task_id === created.payload.id && mission.events.length >= 2), "Persistent Mission projection was not created for the accepted task.");

const flow = await request("/api/v1/tasks", {
  method: "POST",
  body: JSON.stringify({
    prompt: "Prepare a checkpointed chat transfer",
    bot: "flow",
    input: {
      title: "Acceptance chat transfer",
      purpose: "Verify submission checkpoint without moving funds",
      payer: account.address,
      payouts: [{ recipient_name: "Acceptance recipient", recipient_address: "0x2222222222222222222222222222222222222222", asset: "MON", amount: "0.001", milestone: "Acceptance", deadline: null }],
      approval_conditions: ["Exact values reviewed"],
      linked_task_id: null,
    },
  }),
}, token);
assert(flow.response.status === 201 && flow.payload.status.data.workflow.state === "awaiting_approval", "Flow intent creation failed.");
const flowApproved = await request(`/api/v1/tasks/${flow.payload.id}/flow-actions`, { method: "POST", body: JSON.stringify({ action: "approve" }) }, token);
assert(flowApproved.response.ok && flowApproved.payload.task.status.data.workflow.state === "authorized", "Flow authorization failed.");
const checkpointHash = `0x${"ab".repeat(32)}`;
const flowSubmitted = await request(`/api/v1/tasks/${flow.payload.id}/flow-submission`, { method: "POST", body: JSON.stringify({ transaction_hash: checkpointHash }) }, token);
assert(flowSubmitted.response.ok && flowSubmitted.payload.status.data.workflow.state === "submitted", "Flow submission checkpoint failed.");
const flowSubmittedAgain = await request(`/api/v1/tasks/${flow.payload.id}/flow-submission`, { method: "POST", body: JSON.stringify({ transaction_hash: checkpointHash }) }, token);
assert(flowSubmittedAgain.response.ok && flowSubmittedAgain.payload.status.data.workflow.audit_history.filter((event) => event.event === "transaction_submitted").length === 1, "Flow submission checkpoint was not idempotent.");

const operator = await request("/api/v1/tasks", {
  method: "POST",
  body: JSON.stringify({
    prompt: "Prepare a launch draft and a separate Monad Testnet transfer intent",
    bot: "operator",
    input: {
      objective: "Verify durable parallel DONADS coordination",
      target_date: null,
      steps: [
        {
          id: "campaign",
          title: "Prepare a launch draft",
          bot: "growth",
          prompt: "Draft one precise DONADS launch message",
          input: {
            objective: "Explain the verified Vercel deployment",
            start_date: "2026-10-31",
            duration_days: 1,
            platforms: ["x"],
            profile: {
              id: "acceptance-donads",
              project_name: "DONADS",
              product_description: "A Monad-native agent dispatch system",
              target_audience: "Monad builders",
              preferred_tone: "precise and playful",
              terminology: [],
              value_propositions: ["Verifiable task completion"],
              approved_links: [],
              prohibited_terms: [],
              previous_approved_examples: [],
            },
          },
          depends_on: [],
        },
        {
          id: "transfer-intent",
          title: "Prepare a transfer intent",
          bot: "flow",
          prompt: "Prepare, but do not execute, a 0.001 MON transfer intent",
          input: {
            title: "Acceptance transfer",
            purpose: "Verify Flow coordination without moving funds",
            payer: account.address,
            payouts: [{ recipient_name: "Acceptance recipient", recipient_address: "0x2222222222222222222222222222222222222222", asset: "MON", amount: "0.001", milestone: "Acceptance", deadline: null }],
            approval_conditions: ["No automatic payment"],
            linked_task_id: null,
          },
          depends_on: [],
        },
      ],
    },
  }),
}, token);
assert(operator.response.status === 201, `Operator plan failed: ${JSON.stringify(operator.payload)}`);
const started = await request(`/api/v1/tasks/${operator.payload.id}/operator-actions`, {
  method: "POST",
  body: JSON.stringify({ action: "start" }),
}, token);
assert(started.response.ok, `Operator start failed: ${JSON.stringify(started.payload)}`);
let operatorResult = started.payload;
for (let attempt = 0; attempt < 120; attempt += 1) {
  if (["completed", "partial_failure", "failed", "cancelled"].includes(operatorResult.status.data.workflow.state)) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
  const polled = await request(`/api/v1/tasks/${operator.payload.id}`, {}, token);
  assert(polled.response.ok, `Operator polling failed: ${JSON.stringify(polled.payload)}`);
  operatorResult = polled.payload;
}
assert(operatorResult.status.data.workflow.state === "completed", `Operator ended in ${operatorResult.status.data.workflow.state}.`);
assert(operatorResult.status.data.workflow.steps.every((step) => step.status === "completed" && step.task_id), "Operator did not persist both completed child tasks.");

const history = await request("/api/v1/tasks?limit=20", {}, token);
assert(history.response.ok, `History failed: ${JSON.stringify(history.payload)}`);
assert(history.payload.some((task) => task.id === created.payload.id), "Completed task was not persisted in wallet history.");
const approvals = await request("/api/v1/approvals", {}, token);
assert(approvals.response.ok, `Action inbox failed: ${JSON.stringify(approvals.payload)}`);
assert(approvals.payload.some((approval) => approval.task_id === flow.payload.id && approval.kind === "receipt_verification"), "Submitted Flow checkpoint was absent from the cross-device action inbox.");
assert(approvals.payload.every((approval) => approval.task_id && approval.requested_at_ms), "Action inbox returned an invalid checkpoint.");

const logout = await request("/api/v1/auth/logout", { method: "POST" }, token);
assert(logout.response.status === 204, "Logout did not return 204.");
const revoked = await request(`/api/v1/tasks/${created.payload.id}`, {}, token);
assert(revoked.response.status === 401, "Revoked session was not rejected.");

console.log(JSON.stringify({
  base_url: baseUrl,
  wallet: account.address.toLowerCase(),
  task_id: created.payload.id,
  operator_task_id: operator.payload.id,
  operator_state: operatorResult.status.data.workflow.state,
  operator_completed_steps: operatorResult.status.data.workflow.steps.length,
  state: created.payload.status.state,
  finding: created.payload.status.data.findings[0].id,
  threat_score: created.payload.status.data.threat_score,
  history_contains_task: true,
  logout_status: logout.response.status,
  revoked_session_status: revoked.response.status,
  restored_session: true,
  balance_network: balance.payload.network,
  tracked_token_balances: tokenBalances.payload.length,
  erc20_unfunded_policy: unfundedTokenTransfer.payload.status.state,
  dex_adapter_state: dexQuote.response.ok ? "quoted" : "disabled_no_official_bytecode",
  mainnet_enabled: readiness.payload.network_enabled,
  persistent_mission: missions.payload.some((mission) => mission.task_id === created.payload.id),
  ai_remaining_today: aiUsage.payload.remaining_today,
  ai_configured: aiUsage.payload.configured,
  flow_submission_checkpoint: flowSubmitted.payload.status.data.workflow.state,
  pending_action_checkpoints: approvals.payload.length,
}, null, 2));
