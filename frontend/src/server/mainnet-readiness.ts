export type ReadinessGate = { id: string; title: string; passed: boolean; evidence: string };

function artifact(name: string, missing: string): { passed: boolean; evidence: string } {
  const value = process.env[name]?.trim();
  return { passed: Boolean(value), evidence: value ? "Evidence configured server-side" : missing };
}

function twoRpcProviders(): { passed: boolean; evidence: string } {
  const providers = (process.env.MONAD_MAINNET_RPC_URLS ?? "").split(",").map((value) => value.trim()).filter((value) => /^https:\/\//.test(value));
  return { passed: providers.length >= 2, evidence: providers.length ? `${providers.length} HTTPS providers configured` : "Two independent HTTPS RPC providers are required" };
}

export function mainnetReadiness(verifiedTestnetReceipts: number): { ready: boolean; network_enabled: false; passed: number; total: number; gates: ReadinessGate[] } {
  const evidence = (id: string, title: string, env: string, missing: string): ReadinessGate => ({ id, title, ...artifact(env, missing) });
  const rpc = twoRpcProviders();
  const gates: ReadinessGate[] = [
    { id: "testnet-receipts", title: "Ten independently verified Testnet receipts", passed: verifiedTestnetReceipts >= 10, evidence: `${verifiedTestnetReceipts}/10 persisted receipts` },
    evidence("testnet-workflows", "Native, ERC-20, vault, escrow and swap workflows verified", "DONADS_TESTNET_WORKFLOW_ARTIFACT", "Workflow evidence bundle not configured"),
    evidence("contract-invariants", "Contract fuzz and invariant tests passed", "DONADS_CONTRACT_INVARIANT_ARTIFACT", "Invariant report not configured"),
    evidence("contract-review", "Independent smart-contract review completed", "DONADS_SECURITY_REVIEW_ARTIFACT", "Independent review artifact not configured"),
    evidence("application-pentest", "Application penetration test passed", "DONADS_PENTEST_ARTIFACT", "Penetration-test artifact not configured"),
    evidence("ai-adversarial", "Prompt-injection and malicious-file tests passed", "DONADS_AI_SECURITY_ARTIFACT", "AI adversarial-test artifact not configured"),
    evidence("signer-custody", "Reviewed smart-account signer with KMS/HSM controls", "DONADS_SIGNER_KEY_REFERENCE", "Signer key reference not configured"),
    evidence("secret-scan", "No private keys exposed to AI, browsers, logs or storage", "DONADS_SECRET_SCAN_ARTIFACT", "Secret-flow review artifact not configured"),
    { id: "rpc-resilience", title: "Multiple Mainnet RPC providers with health checks", ...rpc },
    evidence("transaction-lifecycle", "Reorg, nonce, replacement and dropped-transaction recovery tested", "DONADS_TRANSACTION_RECOVERY_ARTIFACT", "Transaction recovery test report not configured"),
    evidence("monitoring", "Production monitoring, alerts and incident response ready", "DONADS_INCIDENT_RUNBOOK_URL", "Incident runbook not configured"),
    evidence("emergency-controls", "Emergency pause and revocation drill passed", "DONADS_EMERGENCY_DRILL_ARTIFACT", "Emergency drill artifact not configured"),
    evidence("allowlists", "Contract, token, merchant and DEX allowlists approved", "DONADS_ALLOWLIST_ARTIFACT", "Approved allowlist artifact not configured"),
    evidence("financial-policies", "Spending, expiry, slippage and price-impact policies tested", "DONADS_POLICY_TEST_ARTIFACT", "Policy test report not configured"),
    evidence("multisig-admin", "Administrative permissions controlled by multisig", "DONADS_MULTISIG_ARTIFACT", "Multisig ownership artifact not configured"),
    evidence("backup-recovery", "Database backup and recovery drill passed", "DONADS_RECOVERY_DRILL_ARTIFACT", "Recovery drill artifact not configured"),
    evidence("data-governance", "Privacy, retention and connector-token policies approved", "DONADS_DATA_POLICY_ARTIFACT", "Data governance policy not configured"),
    evidence("merchant-operations", "Merchant refund and support procedures tested", "DONADS_MERCHANT_SUPPORT_ARTIFACT", "Merchant operations artifact not configured"),
    evidence("limited-beta", "Limited-wallet beta passed conservative caps", "DONADS_BETA_ARTIFACT", "Limited-wallet beta report not configured"),
    evidence("go-no-go", "Final go/no-go review signed", "DONADS_GO_NO_GO_ARTIFACT", "Final launch decision not configured"),
  ];
  const passed = gates.filter((gate) => gate.passed).length;
  return { ready: passed === gates.length, network_enabled: false, passed, total: gates.length, gates };
}
