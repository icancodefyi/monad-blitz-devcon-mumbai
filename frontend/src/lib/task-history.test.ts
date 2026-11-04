import { describe, expect, it } from "vitest";

import type { Task } from "@/lib/donads-api";
import { canDeleteTaskHistory, createTaskTitle, taskDisplayTitle } from "@/lib/task-history";

describe("task history", () => {
  it("creates concise human titles from prompts", () => {
    expect(createTaskTitle("Please research https://monad.xyz and summarize the key facts", "scout"))
      .toBe("Research monad.xyz and summarize the key facts");
    expect(createTaskTitle("Send 0.01 MON to 0x1111111111111111111111111111111111111111", "flow"))
      .toBe("Send 0.01 MON to 0x1111…1111");
  });

  it("prefers the persisted task title", () => {
    expect(taskDisplayTitle({ title: "Monad launch research", prompt: "A long prompt", bot: "scout" }))
      .toBe("Monad launch research");
  });

  it("protects an unresolved payment from history deletion", () => {
    const task = {
      bot: "flow",
      status: { state: "completed", data: { workflow: { state: "awaiting_approval" } } },
    } as Task;
    expect(canDeleteTaskHistory(task)).toEqual({
      allowed: false,
      reason: "Confirm or reject the payment before deleting this history item.",
    });
  });
});
