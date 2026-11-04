import { describe, expect, it } from "vitest";

import { isPublicAddress } from "@/server/public-web";

describe("public web address policy", () => {
  it.each(["127.0.0.1", "10.0.0.8", "169.254.169.254", "192.168.1.2", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"])("blocks %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])("allows public address %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});
