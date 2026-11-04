import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  captureOperatorRoutine,
  deleteTaskHistory,
  extractSourceUrls,
} from "./donads-api";

afterEach(() => vi.unstubAllGlobals());

describe("extractSourceUrls", () => {
  it("extracts and deduplicates public source URLs", () => {
    expect(
      extractSourceUrls(
        "Compare https://docs.monad.xyz and https://docs.monad.xyz against http://example.com/page.",
      ),
    ).toEqual(["https://docs.monad.xyz/", "http://example.com/page"]);
  });

  it("requires a source instead of inventing research", () => {
    expect(() => extractSourceUrls("Research Monad for me")).toThrow(ApiError);
  });

  it("enforces the source limit", () => {
    const prompt = Array.from(
      { length: 6 },
      (_, index) => `https://example.com/${index}`,
    ).join(" ");
    expect(() => extractSourceUrls(prompt)).toThrow(/up to 5/i);
  });
});

describe("Operator routines API", () => {
  it("captures only through the completed-task routine endpoint", async () => {
    const payload = {
      id: "research-draft",
      name: "Research draft",
      description: "Approved workflow",
      version: 1,
      created_at_ms: 1,
      updated_at_ms: 1,
      input: { objective: "Research", target_date: null, steps: [] },
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      captureOperatorRoutine("task-1", {
        id: payload.id,
        name: payload.name,
        description: payload.description,
      }),
    ).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/tasks/task-1/routine",
      expect.objectContaining({ method: "POST" }),
    );
  });

});

describe("Task history API", () => {
  it("deletes a wallet-owned history item through the task endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteTaskHistory("task-1")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/tasks/task-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
