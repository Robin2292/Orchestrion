import { describe, expect, it } from "vitest";
import { assertSupportedNodeVersion } from "./require-node-22.mjs";

describe("desktop Node runtime", () => {
  it("accepts Node 22.x", () => {
    expect(() => assertSupportedNodeVersion("22.0.0")).not.toThrow();
    expect(() => assertSupportedNodeVersion("22.22.0")).not.toThrow();
  });

  it("rejects unsupported and malformed versions with an actionable error", () => {
    expect(() => assertSupportedNodeVersion("20.17.0")).toThrow("requires Node 22.x; received Node 20.17.0");
    expect(() => assertSupportedNodeVersion("26.8.1")).toThrow("requires Node 22.x; received Node 26.8.1");
    expect(() => assertSupportedNodeVersion("not-a-version")).toThrow("requires Node 22.x");
  });
});
