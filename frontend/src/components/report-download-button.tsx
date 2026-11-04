"use client";

import { Download } from "lucide-react";
import { useState } from "react";

import type { CompletedTask } from "@/lib/donads-api";
import { downloadTaskReport } from "@/lib/task-report";

export function ReportDownloadButton({ task }: { task: CompletedTask }) {
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setExporting(true);
    setError(null);
    try {
      await downloadTaskReport(task);
    } catch {
      setError("Could not generate the report. Try again.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        onClick={() => void download()}
        disabled={exporting}
        aria-busy={exporting}
        className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border bg-card px-4 text-sm font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-50"
      >
        <Download className="size-4" aria-hidden="true" />
        {exporting ? "Generating PDF…" : "Download PDF report"}
      </button>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
