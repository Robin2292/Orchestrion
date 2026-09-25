import { describe,expect,it } from "vitest";
import { GOVERNED_TOOLS } from "../../shared/governed-tool-contracts";
import { reviewedBuiltinCatalog } from "./catalog";

describe("reviewed built-in configuration catalog",() => {
  it("is a closed, data-only projection with stable distinct fingerprints",() => {
    const catalog=reviewedBuiltinCatalog();
    expect(catalog.map((tool) => tool.name)).toEqual([...GOVERNED_TOOLS]);
    expect(catalog.every((tool) => tool.source === "reviewed_builtin" && tool.authority === "none")).toBe(true);
    expect(new Set(catalog.map((tool) => tool.contractHash)).size).toBe(catalog.length);
    expect(JSON.stringify(catalog)).not.toMatch(/adapter|planner|grant|attemptId|policyId/i);
  });

  it("fails closed when an executable declaration drifts from the reviewed snapshot",() => {
    const bodies=reviewedBuiltinCatalog().map(({ contractHash: _hash,source: _source,authority: _authority,...body }) => body);
    bodies[1]={ ...bodies[1],implementationVersion:"v2" };
    expect(() => reviewedBuiltinCatalog(bodies)).toThrow("TOOL_SCHEMA_DRIFT");
  });
});
