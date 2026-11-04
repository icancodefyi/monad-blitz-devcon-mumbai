import { describe, expect, it } from "vitest";

import type { SentinelCompletedTask } from "./donads-api";
import { buildTaskReport, flattenReportData, generateTaskReportPdf } from "./task-report";

const task: SentinelCompletedTask = {
  id: "72c191d7-61ca-4afa-92e9-25ceb3f03a21",
  owner_id: "0x1111111111111111111111111111111111111111",
  title: "Bytecode risk assessment",
  prompt: "Scan this bytecode",
  bot: "sentinel",
  input: { bytecode: "0x60ff" },
  events: [{ sequence: 1, kind: "completed", message: "Scan completed.", at_ms: 1_700_000_001_000 }],
  created_at_ms: 1_700_000_000_000,
  updated_at_ms: 1_700_000_001_000,
  feedback: null,
  status: {
    state: "completed",
    summary: "One risk signal found.",
    latency_ms: 12,
    data: {
      threat_score: 60,
      bytecode_bytes: 2,
      findings: [{ id: "SELFDESTRUCT", severity: "high", title: "Self destruct", evidence: "0xff" }],
      scope: "Executable bytecode",
      disclaimer: "Triage only.",
    },
  },
};

describe("task report model", () => {
  it("creates deterministic structured sections", () => {
    const report = buildTaskReport(task);
    expect(report.title).toBe("Bytecode risk assessment");
    expect(report.subtitle).toBe("Sentinel completion report");
    expect(report.summary).toBe("One risk signal found.");
    expect(report.highlights[0]).toContain("HIGH: Self destruct");
    expect(report.filename).toBe("donads-sentinel-72c191d7.pdf");
    expect(report.metadata).toContainEqual(["Worked for", "1s"]);
    expect(report.result).toContainEqual(["Threat score", "60"]);
    expect(report.activity[0][2]).toBe("Scan completed.");
  });

  it("omits sensitive fields from exports", () => {
    const rows = flattenReportData({ result: "safe", access_token: "hidden", nested: { private_key: "hidden" } });
    expect(rows).toEqual([["Result", "safe"]]);
  });

  it("renders a valid PDF document", async () => {
    const pdf = await generateTaskReportPdf(task);
    expect(pdf.filename).toBe("donads-sentinel-72c191d7.pdf");
    expect(new TextDecoder().decode(pdf.bytes.slice(0, 8))).toMatch(/^%PDF-/);
    expect(pdf.bytes.byteLength).toBeGreaterThan(3_000);
  });
});
