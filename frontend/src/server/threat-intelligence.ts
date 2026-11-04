import { isAddress } from "viem";

export type ThreatSeverity = "low" | "medium" | "high" | "critical";

export type ThreatFinding = {
  code: string;
  severity: Exclude<ThreatSeverity, "low">;
  message: string;
  evidence: string;
};

export type ThreatReport = {
  severity: ThreatSeverity;
  score: number;
  blocked: boolean;
  urls: string[];
  addresses: string[];
  findings: ThreatFinding[];
  summary: string;
  limitations: string[];
  checked_at_ms: number;
};

const OFFICIAL_DOMAINS = new Set([
  "monad.xyz", "monadscan.com", "uniswap.org", "app.uniswap.org", "metamask.io",
  "walletconnect.network", "reown.com", "binance.com", "coinbase.com",
]);
const PROTECTED_BRANDS = ["monad", "uniswap", "metamask", "walletconnect", "reown", "binance", "coinbase"];
const SHORTENERS = new Set(["bit.ly", "tinyurl.com", "t.co", "is.gd", "cutt.ly", "rb.gy"]);
const RISKY_TERMS = /\b(seed phrase|secret recovery|private key|verify wallet|wallet verification|urgent claim|claim airdrop|free token|double your|support agent)\b/i;
const DANGEROUS_EXTENSION = /\.(exe|msi|scr|bat|cmd|ps1|apk|dmg|pkg|jar)(?:$|[?#])/i;

function distance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = row[0]; row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const previous = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = previous;
    }
  }
  return row[right.length];
}

function isOfficial(hostname: string): boolean {
  return [...OFFICIAL_DOMAINS].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function add(findings: ThreatFinding[], finding: ThreatFinding): void {
  if (!findings.some((current) => current.code === finding.code && current.evidence === finding.evidence)) findings.push(finding);
}

export function extractUrls(input: string): string[] {
  return [...new Set(input.match(/https?:\/\/[^\s<>{}\[\]"']+/gi)?.map((value) => value.replace(/[),.;!?]+$/, "")) ?? [])].slice(0, 10);
}

export function assessThreat(input: { text: string; urls?: string[]; transactionData?: string }): ThreatReport {
  const findings: ThreatFinding[] = [];
  const urls = [...new Set([...(input.urls ?? []), ...extractUrls(input.text)])].slice(0, 10);
  const addresses = [...new Set(input.text.match(/0x[0-9a-fA-F]{40}\b/g) ?? [])].filter((address) => isAddress(address)).slice(0, 20);

  if (RISKY_TERMS.test(input.text)) add(findings, { code: "SECRET_OR_SOCIAL_ENGINEERING_REQUEST", severity: "critical", message: "The request uses language commonly associated with credential theft or wallet-draining scams.", evidence: input.text.match(RISKY_TERMS)?.[0] ?? "suspicious wording" });

  for (const raw of urls) {
    let url: URL;
    try { url = new URL(raw); } catch {
      add(findings, { code: "MALFORMED_URL", severity: "high", message: "The link is malformed and cannot be safely normalized.", evidence: raw });
      continue;
    }
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    const official = isOfficial(host);
    if (url.protocol !== "https:") add(findings, { code: "INSECURE_HTTP", severity: "medium", message: "The link does not use HTTPS.", evidence: raw });
    if (url.username || url.password) add(findings, { code: "EMBEDDED_CREDENTIALS", severity: "critical", message: "The link hides credentials before the hostname, a common phishing technique.", evidence: raw });
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || /^\[[0-9a-f:]+\]$/i.test(host)) add(findings, { code: "IP_LITERAL_HOST", severity: "high", message: "The link uses an IP address instead of a verifiable domain.", evidence: host });
    if (host.includes("xn--")) add(findings, { code: "PUNYCODE_DOMAIN", severity: "high", message: "The domain uses internationalized punycode and may imitate a trusted brand.", evidence: host });
    if (SHORTENERS.has(host)) add(findings, { code: "SHORTENED_LINK", severity: "high", message: "The shortened link hides its final destination.", evidence: host });
    if (DANGEROUS_EXTENSION.test(url.pathname)) add(findings, { code: "EXECUTABLE_DOWNLOAD", severity: "critical", message: "The link appears to download executable software.", evidence: url.pathname });
    if (!official) {
      const labels = host.split(".");
      for (const brand of PROTECTED_BRANDS) {
        const lookalike = labels.find((label) => label !== brand && distance(label, brand) === 1);
        if (lookalike) add(findings, { code: "BRAND_LOOKALIKE", severity: "critical", message: `The domain closely imitates ${brand} but is not an official ${brand} domain.`, evidence: host });
        else if (labels.some((label) => label.includes(brand))) add(findings, { code: "BRAND_IN_UNTRUSTED_DOMAIN", severity: "high", message: `The domain contains the protected brand name ${brand} but is not allowlisted.`, evidence: host });
      }
    }
    if (host.split(".").length > 5 || host.split("-").length > 5) add(findings, { code: "OBFUSCATED_DOMAIN", severity: "medium", message: "The hostname is unusually complex and should be verified manually.", evidence: host });
  }

  const data = input.transactionData?.toLowerCase();
  if (data?.startsWith("0xa22cb465")) add(findings, { code: "NFT_OPERATOR_APPROVAL", severity: "critical", message: "This transaction grants an operator control over all NFTs in a collection.", evidence: "setApprovalForAll" });
  if (data?.startsWith("0x095ea7b3") && /f{64}$/.test(data)) add(findings, { code: "UNLIMITED_TOKEN_APPROVAL", severity: "critical", message: "This transaction appears to grant an unlimited token allowance.", evidence: "approve(max_uint256)" });

  const weights = { medium: 20, high: 45, critical: 80 } as const;
  const score = Math.min(100, findings.reduce((total, finding) => total + weights[finding.severity], 0));
  const severity: ThreatSeverity = findings.some((finding) => finding.severity === "critical") ? "critical" : findings.some((finding) => finding.severity === "high") ? "high" : findings.length ? "medium" : "low";
  const blocked = severity === "critical" || severity === "high";
  return {
    severity, score, blocked, urls, addresses, findings,
    summary: blocked ? `Sentinel blocked this request after finding ${findings.length} high-risk signal${findings.length === 1 ? "" : "s"}.` : findings.length ? `Sentinel found ${findings.length} warning${findings.length === 1 ? "" : "s"}; review before continuing.` : "Sentinel found no deterministic threat signals in the supplied text and links.",
    limitations: ["This is deterministic preflight screening, not a guarantee that a site, address, token, or contract is safe.", "Live reputation feeds, downloaded-file malware scanning, and full smart-contract simulation require separately configured providers."],
    checked_at_ms: Date.now(),
  };
}
