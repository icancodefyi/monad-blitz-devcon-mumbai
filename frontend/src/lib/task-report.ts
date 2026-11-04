import type { CompletedTask } from "@/lib/donads-api";
import { formatTaskDuration, taskCompletionTime } from "@/lib/task-receipt";
import { taskDisplayTitle } from "@/lib/task-history";

export type ReportRow = [label: string, value: string];

export type TaskReportModel = {
  title: string;
  subtitle: string;
  summary: string;
  highlights: string[];
  filename: string;
  metadata: ReportRow[];
  request: ReportRow[];
  result: ReportRow[];
  activity: Array<[time: string, event: string, message: string]>;
};

const sensitiveKey = /(access.?token|authorization|cookie|private.?key|seed.?phrase|secret|signature)/i;

function words(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (character) => character.toUpperCase());
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Not provided";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return new Intl.NumberFormat("en-US").format(value);
  return String(value).slice(0, 1_200);
}

export function flattenReportData(value: unknown): ReportRow[] {
  const rows: ReportRow[] = [];

  function visit(current: unknown, path: string[]): void {
    if (rows.length >= 300) return;
    if (current === null || typeof current !== "object") {
      rows.push([path.map(words).join(" / ") || "Value", display(current)]);
      return;
    }
    if (Array.isArray(current)) {
      if (current.length === 0) {
        rows.push([path.map(words).join(" / ") || "Items", "None"]);
      } else if (current.every((item) => item === null || typeof item !== "object")) {
        rows.push([path.map(words).join(" / ") || "Items", current.map(display).join(", ")]);
      } else {
        current.forEach((item, index) => visit(item, [...path, `Item ${index + 1}`]));
      }
      return;
    }
    const allEntries = Object.entries(current as Record<string, unknown>);
    const entries = allEntries.filter(
      ([key]) => !sensitiveKey.test(key),
    );
    if (allEntries.length === 0 && path.length > 0) {
      rows.push([path.map(words).join(" / "), "None"]);
    }
    entries.forEach(([key, item]) => visit(item, [...path, key]));
  }

  visit(value, []);
  if (rows.length === 300) rows.push(["Report limit", "Additional fields were omitted."]);
  return rows;
}

function formatTime(milliseconds: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(milliseconds));
}

function reportHighlights(task: CompletedTask): string[] {
  if (task.bot === "scout") {
    return task.status.data.report.findings.slice(0, 6).map((finding) => finding.text);
  }
  if (task.bot === "growth") {
    const campaign = task.status.data.campaign;
    return [
      `${campaign.calendar.length} review-ready drafts were prepared for ${campaign.target_audience}.`,
      `Channels: ${[...new Set(campaign.calendar.map((day) => day.platform))].join(", ")}.`,
      "Publishing remained disabled; every draft still requires human review.",
    ];
  }
  if (task.bot === "sentinel") {
    const findings = task.status.data.findings.map((finding) => `${finding.severity.toUpperCase()}: ${finding.title} — ${finding.evidence}`);
    return findings.length ? findings : ["No deterministic opcode risk signals were detected in the supplied executable bytecode."];
  }
  if (task.bot === "operator") {
    return task.status.data.workflow.steps.map((step) => `${step.title}: ${step.summary ?? step.status}.`);
  }
  if (task.bot === "commerce") {
    const workflow = task.status.data.workflow;
    return [
      `Selected ${workflow.selected_offer.name} from ${workflow.selected_offer.merchant}.`,
      `Validated total: ${workflow.total_atomic} ${workflow.asset} atomic units.`,
      workflow.order_receipt ? `Order receipt ${workflow.order_receipt.order_id} was verified.` : "No verified order receipt was produced.",
    ];
  }
  const workflow = task.status.data.workflow;
  const executions = workflow.executions ?? (workflow.execution ? [{ payout_index: 0, ...workflow.execution }] : []);
  return [
    `Approved total: ${workflow.totals[0]?.amount} ${workflow.totals[0]?.asset} across ${workflow.payouts.length} recipient(s).`,
    ...workflow.payouts.map((payout, index) => `Recipient ${index + 1}: ${payout.amount} ${payout.asset} to ${payout.recipient_address}.`),
    executions.length ? `${executions.length}/${workflow.payouts.length} transaction receipt(s) were independently verified.` : "No verified on-chain execution receipt was produced.",
    `Final payment state: ${workflow.state.replaceAll("_", " ")}.`,
  ];
}

export function buildTaskReport(task: CompletedTask): TaskReportModel {
  const specialist = words(task.bot);
  const title = taskDisplayTitle(task);
  return {
    title,
    subtitle: `${specialist} completion report`,
    summary: task.status.summary,
    highlights: reportHighlights(task),
    filename: `donads-${task.bot}-${task.id.slice(0, 8)}.pdf`,
    metadata: [
      ["Task ID", task.id],
      ["Specialist", specialist],
      ["Task status", task.status.state],
      ["Created (UTC)", formatTime(task.created_at_ms)],
      ["Updated (UTC)", formatTime(task.updated_at_ms)],
      ["Worked for", formatTaskDuration(taskCompletionTime(task) - task.created_at_ms)],
      ["Specialist processing time", `${task.status.latency_ms} ms`],
      ["Summary", task.status.summary],
    ],
    request: [["Prompt", task.prompt], ...flattenReportData(task.input)],
    result: flattenReportData(task.status.data),
    activity: task.events.map((event) => [
      formatTime(event.at_ms),
      words(event.kind),
      event.message,
    ]),
  };
}

async function loadMascot(): Promise<Uint8Array | null> {
  try {
    const response = await fetch("/brand/donads-mascot-tile.png");
    if (!response.ok) return null;
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }
}

export async function generateTaskReportPdf(
  task: CompletedTask,
): Promise<{ filename: string; bytes: ArrayBuffer }> {
  const [{ jsPDF }, { default: autoTable }, mascot] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
    loadMascot(),
  ]);
  const report = buildTaskReport(task);
  const document = new jsPDF({ unit: "mm", format: "a4", compress: true });
  const pageWidth = document.internal.pageSize.getWidth();
  const margin = 16;
  const ink: [number, number, number] = [21, 16, 14];
  const primary: [number, number, number] = [64, 46, 37];
  const muted: [number, number, number] = [247, 244, 240];
  const border: [number, number, number] = [210, 201, 193];

  document.setProperties({
    title: report.title,
    subject: `DONADS verified task record ${task.id}`,
    author: "DONADS",
    creator: "DONADS report exporter",
  });
  document.setFillColor(...primary);
  document.rect(0, 0, pageWidth, 48, "F");
  document.setTextColor(255, 255, 255);
  document.setFont("helvetica", "bold");
  document.setFontSize(10);
  document.text("DONADS  /  VERIFIED TASK RECORD", margin, 14);
  document.setFontSize(21);
  const titleLines = document.splitTextToSize(report.title, pageWidth - (margin * 2) - 26).slice(0, 2) as string[];
  document.text(titleLines, margin, 25);
  document.setFont("helvetica", "normal");
  document.setFontSize(8.5);
  document.setTextColor(234, 225, 219);
  document.text(report.subtitle, margin, 42);
  if (mascot) document.addImage(mascot, "PNG", pageWidth - margin - 19, 14, 19, 19);

  let cursor = 58;
  const tableDocument = document as typeof document & { lastAutoTable?: { finalY: number } };
  const ensureSpace = (required: number) => {
    if (cursor + required <= 272) return;
    document.addPage();
    cursor = 20;
  };
  const sectionHeading = (heading: string, caption?: string) => {
    ensureSpace(caption ? 18 : 11);
    document.setTextColor(...primary);
    document.setFont("helvetica", "bold");
    document.setFontSize(11);
    document.text(heading, margin, cursor);
    cursor += 5;
    if (caption) {
      document.setFont("helvetica", "normal");
      document.setFontSize(8);
      document.setTextColor(100, 91, 86);
      document.text(caption, margin, cursor);
      cursor += 6;
    }
  };

  document.setFillColor(...muted);
  document.roundedRect(margin, cursor, pageWidth - margin * 2, 25, 3, 3, "F");
  document.setFont("helvetica", "bold");
  document.setFontSize(8);
  document.setTextColor(...primary);
  document.text("OUTCOME SUMMARY", margin + 5, cursor + 7);
  document.setFont("helvetica", "normal");
  document.setFontSize(10);
  document.setTextColor(...ink);
  const summaryLines = document.splitTextToSize(report.summary, pageWidth - margin * 2 - 10).slice(0, 3) as string[];
  document.text(summaryLines, margin + 5, cursor + 14);
  cursor += 34;

  sectionHeading("Key outcomes", "The most important results, written for quick review.");
  report.highlights.forEach((highlight, index) => {
    const lines = document.splitTextToSize(highlight, pageWidth - margin * 2 - 14) as string[];
    const height = Math.max(10, lines.length * 4.2 + 5);
    ensureSpace(height);
    document.setFillColor(255, 255, 255);
    document.setDrawColor(...border);
    document.roundedRect(margin, cursor, pageWidth - margin * 2, height, 2, 2, "FD");
    document.setFillColor(...primary);
    document.circle(margin + 6, cursor + 5.5, 2.5, "F");
    document.setTextColor(255, 255, 255);
    document.setFont("helvetica", "bold");
    document.setFontSize(7);
    document.text(String(index + 1), margin + 6, cursor + 6.3, { align: "center" });
    document.setTextColor(...ink);
    document.setFont("helvetica", "normal");
    document.setFontSize(9);
    document.text(lines, margin + 12, cursor + 6.5);
    cursor += height + 3;
  });
  cursor += 4;

  const addTable = (heading: string, head: string[], body: string[][], widths?: Record<number, { cellWidth: number }>) => {
    ensureSpace(35);
    sectionHeading(heading);
    autoTable(document, {
      startY: cursor,
      margin: { left: margin, right: margin, top: 16, bottom: 16 },
      head: [head],
      body,
      theme: "grid",
      styles: { font: "helvetica", fontSize: 8.5, cellPadding: 2.5, textColor: ink, lineColor: border, lineWidth: 0.15, overflow: "linebreak" },
      headStyles: { fillColor: primary, textColor: [255, 255, 255], fontStyle: "bold" },
      alternateRowStyles: { fillColor: muted },
      columnStyles: widths,
    });
    cursor = (tableDocument.lastAutoTable?.finalY ?? cursor + 12) + 10;
  };

  addTable("Task facts", ["Field", "Value"], report.metadata, { 0: { cellWidth: 42 } });
  addTable("Original request", ["Field", "Value"], report.request, { 0: { cellWidth: 52 } });
  addTable("Technical appendix", ["Field", "Value"], report.result, { 0: { cellWidth: 62 } });
  addTable("Execution timeline", ["Time (UTC)", "Event", "Message"], report.activity, {
    0: { cellWidth: 34 },
    1: { cellWidth: 30 },
  });

  const pages = document.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    document.setPage(page);
    document.setDrawColor(...border);
    document.line(margin, 283, pageWidth - margin, 283);
    document.setFont("helvetica", "normal");
    document.setFontSize(7.5);
    document.setTextColor(100, 91, 86);
    document.text("Generated locally by DONADS. Verify financial and security results before acting.", margin, 289);
    document.text(`${page} / ${pages}`, pageWidth - margin, 289, { align: "right" });
  }
  return { filename: report.filename, bytes: document.output("arraybuffer") };
}

export async function downloadTaskReport(task: CompletedTask): Promise<void> {
  const report = await generateTaskReportPdf(task);
  const url = URL.createObjectURL(new Blob([report.bytes], { type: "application/pdf" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = report.filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
