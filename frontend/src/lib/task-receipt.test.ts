import { describe, expect, it } from "vitest";

import { formatTaskDuration, taskCompletionTime } from "@/lib/task-receipt";

describe("task receipts", () => {
  it("formats short, minute, and hour durations", () => {
    expect(formatTaskDuration(0)).toBe("<1s");
    expect(formatTaskDuration(249_000)).toBe("4m 9s");
    expect(formatTaskDuration(3_723_000)).toBe("1h 2m 3s");
  });

  it("uses the latest persisted timestamp as completion time", () => {
    expect(taskCompletionTime({
      id: "task-1", owner_id: "wallet:0x1", prompt: "demo", bot: "scout", input: {},
      events: [{ sequence: 1, kind: "completed", message: "Done", at_ms: 4_000 }],
      created_at_ms: 1_000, updated_at_ms: 3_000, feedback: null,
    })).toBe(4_000);
  });
});
