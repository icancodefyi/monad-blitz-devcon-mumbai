import { describe, expect, it } from "vitest";
import { assessThreat, extractUrls } from "@/server/threat-intelligence";

describe("Sentinel preflight threat intelligence", () => {
  it("allows an official HTTPS domain without claiming safety", () => {
    const report = assessThreat({ text: "Research https://monad.xyz" });
    expect(report).toMatchObject({ severity: "low", blocked: false, score: 0 });
    expect(report.limitations[0]).toContain("not a guarantee");
  });

  it("blocks brand lookalikes and credential-hiding links", () => {
    const report = assessThreat({ text: "Open https://name:pass@monad-login.example/claim" });
    expect(report.blocked).toBe(true);
    expect(report.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(["EMBEDDED_CREDENTIALS", "BRAND_IN_UNTRUSTED_DOMAIN"]));
  });

  it("blocks secret-recovery social engineering", () => {
    expect(assessThreat({ text: "Enter your seed phrase to verify wallet" })).toMatchObject({ severity: "critical", blocked: true });
  });

  it("blocks unlimited approvals and NFT operator approvals", () => {
    const unlimited = `0x095ea7b3${"0".repeat(64)}${"f".repeat(64)}`;
    expect(assessThreat({ text: "approve", transactionData: unlimited }).findings[0]?.code).toBe("UNLIMITED_TOKEN_APPROVAL");
    expect(assessThreat({ text: "approve", transactionData: `0xa22cb465${"0".repeat(128)}` }).findings[0]?.code).toBe("NFT_OPERATOR_APPROVAL");
  });

  it("extracts bounded normalized link candidates", () => {
    expect(extractUrls("See https://monad.xyz, then https://app.uniswap.org.")).toEqual(["https://monad.xyz", "https://app.uniswap.org"]);
  });
});
