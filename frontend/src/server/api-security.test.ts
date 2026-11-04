import { describe, expect, it } from "vitest";

import { assertTrustedOrigin, PublicApiError, safeFailure } from "@/server/api-security";

describe("API security boundary", () => {
  it("rejects a cross-origin state change", () => {
    const request = new Request("https://donads.example/api/v1/tasks", { method: "POST", headers: { origin: "https://attacker.example" } });
    expect(() => assertTrustedOrigin(request)).toThrow(PublicApiError);
  });

  it("allows same-origin and non-browser requests", () => {
    expect(() => assertTrustedOrigin(new Request("https://donads.example/api/v1/tasks", { method: "POST", headers: { origin: "https://donads.example" } }))).not.toThrow();
    expect(() => assertTrustedOrigin(new Request("https://donads.example/api/v1/tasks", { method: "POST" }))).not.toThrow();
  });

  it("redacts unexpected internal errors", () => {
    expect(safeFailure(new Error("postgres password was invalid"))).toEqual({
      status: 500, code: "INTERNAL_ERROR",
      message: "DONADS could not complete this request. Retry once; if it continues, check the Mission timeline.",
    });
  });
});
