import { describe, expect, it } from "vitest";

import canonicalFixture from "../../fixtures/tool-source-catalog-v1.fixture.json";
import type { LocalContext } from "../shared/local-contracts";
import { LocalToolSourceCatalogSchema } from "../shared/tool-source-contracts";
import { canonicalToolProjection } from "../shared/tool-projection";
import type { ToolDefinition } from "../shared/tool-registry-contracts";
import { reviewedBuiltinCatalog } from "./builtins/catalog";
import { projectLocalToolSources } from "./source-catalog";
import { toolAnchor, toolDigest } from "./registry";

const hash = (char: string) => `sha256:${char.repeat(64)}`;
const context = (
  project_id = "project-a",
  principalId = "user-a",
  org_id = "org-a",
): LocalContext => ({
  org_id,
  project_id,
  principal: { type: "user", id: principalId },
});
const discovery = (
  id: string,
  state: "accepted" | "rejected" | "quarantined" | "unsupported" | "needs_setup",
  scope = context(),
  latest: string | null = hash("a"),
  accepted: string | null = hash("a"),
  namespace = "mcp.shared",
) => ({
  context: scope,
  kind: "mcp" as const,
  namespace,
  label: id,
  connection: { id, authorityHash: hash("c") },
  state,
  reasonCode: `STATE_${state.toUpperCase()}`,
  credentialReadiness: state === "needs_setup" ? "missing" as const : "ready" as const,
  contentDigest: latest,
  acceptedContentDigest: accepted,
  tools: [{
    key: "lookup",
    name: "shared.lookup",
    description: "remote annotation",
    inputSchema: { type: "object" as const },
    outputSchema: null,
    annotations: {
      readOnlyHint: true,
      pluginManifest: true,
      requiredBySkill: "reporter",
      suggestedByModel: true,
    },
  }],
});
const builtinDefinition = (
  scope: LocalContext = context(),
): ToolDefinition => {
  const descriptor = reviewedBuiltinCatalog()[0];
  return {
    context: scope,
    sourceId: "toolset-a",
    connectorId: descriptor.connectorId,
    connectionId: descriptor.connectionId,
    name: descriptor.name,
    description: descriptor.description,
    parameters: descriptor.parameters,
    outputSchema: descriptor.outputSchema,
    implementationId: descriptor.implementationId,
    implementationVersion: descriptor.implementationVersion,
    policyMode: "external",
  };
};
const persistedContract = (definition: ToolDefinition) => ({
  context: definition.context,
  tool: { source: definition.connectorId, key: definition.name },
  anchor: toolAnchor(definition),
  schema_hash: toolDigest([definition.parameters, definition.outputSchema]),
  contract_json: canonicalToolProjection(definition),
});
const inputs = (overrides: Partial<Parameters<typeof projectLocalToolSources>[0]> = {}) => ({
  context: context(),
  workspace: { id: "project-a", hash: hash("d") },
  builtins: [],
  registered: [],
  contracts: [],
  discoveries: [],
  ...overrides,
});

describe("Local Source catalog", () => {
  it("parses the canonical Backend/Web/Local fixture", () => {
    expect(LocalToolSourceCatalogSchema.parse(canonicalFixture)).toEqual(canonicalFixture);
  });
  it("keeps equal Tool names from multiple Connections unambiguous and authority-free", () => {
    const value = projectLocalToolSources(inputs({
      discoveries: [discovery("account-a", "accepted"), discovery("account-b", "accepted")],
    }));
    const tools = value.sources
      .filter((source) => source.kind === "mcp")
      .flatMap((source) => source.connections.flatMap((connection) => connection.tools));
    expect(new Set(tools.map((tool) => tool.catalogId)).size).toBe(2);
    expect(tools.map((tool) => tool.selection?.connection?.id).sort()).toEqual(["account-a", "account-b"]);
    expect(value.authority).toBe("none");
    expect(value.sources.every((source) => source.authority === "none")).toBe(true);
    expect(tools.every((tool) => tool.authority === "none" && tool.contract === null)).toBe(true);
    expect(tools.every((tool) => tool.metadata.annotations.readOnlyHint === true)).toBe(true);
    expect(tools.every((tool) => tool.grantReadiness === "needs_publish")).toBe(true);
  });

  it("uses only full-context persisted immutable contracts and never descriptor pins", () => {
    const descriptor = reviewedBuiltinCatalog()[0];
    const definition = builtinDefinition();
    const withoutContract = projectLocalToolSources(inputs({
      builtins: [descriptor],
      registered: [definition],
    }));
    const pending = withoutContract.sources[0].connections[0].tools[0];
    expect(pending.contract).toBeNull();
    expect(pending.grantReadiness).toBe("needs_publish");
    expect(pending.metadata.annotations.reviewedDescriptorDigest).toBe(descriptor.contractHash);

    const contract = persistedContract(definition);
    const accepted = projectLocalToolSources(inputs({
      builtins: [descriptor],
      registered: [definition],
      contracts: [contract],
    })).sources[0].connections[0].tools[0];
    expect(accepted.contract).toMatchObject({
      versionId: contract.anchor.tool_contract_version_id,
      contractHash: contract.anchor.tool_contract_hash,
      schemaHash: contract.schema_hash,
      physicalReadonlyProven: false,
    });
    expect(accepted.grantReadiness).toBe("ready");

    const drifted = structuredClone(contract);
    drifted.anchor.tool_contract_hash = hash("e");
    const quarantined = projectLocalToolSources(inputs({
      builtins: [descriptor],
      registered: [definition],
      contracts: [drifted],
    })).sources[0].connections[0].tools[0];
    expect(quarantined.contract).toBeNull();
    expect(quarantined.state).toBe("quarantined");
    expect(quarantined.grantReadiness).toBe("needs_review");
  });

  it("requires equal organization, project, and principal context", () => {
    const descriptor = reviewedBuiltinCatalog()[0];
    const own = builtinDefinition();
    const value = projectLocalToolSources(inputs({
      builtins: [descriptor],
      registered: [
        own,
        builtinDefinition(context("project-b")),
        builtinDefinition(context("project-a", "user-b")),
        builtinDefinition(context("project-a", "user-a", "org-b")),
      ],
      contracts: [
        persistedContract(own),
        persistedContract(builtinDefinition(context("project-b"))),
      ],
      discoveries: [
        discovery("own", "accepted"),
        discovery("foreign-project", "accepted", context("project-b")),
        discovery("foreign-principal", "accepted", context("project-a", "user-b")),
        discovery("foreign-org", "accepted", context("project-a", "user-a", "org-b")),
      ],
    }));
    const allTools = value.sources.flatMap((source) =>
      source.connections.flatMap((connection) => connection.tools));
    expect(allTools).toHaveLength(2);
    expect(JSON.stringify(value)).not.toContain("foreign-");
  });

  it("preserves review/setup states and content drift without installing candidates", () => {
    const value = projectLocalToolSources(inputs({
      discoveries: [
        discovery("accepted", "accepted"),
        discovery("rejected", "rejected"),
        discovery("quarantined", "quarantined", context(), hash("b"), hash("a")),
        discovery("unsupported", "unsupported"),
        discovery("setup", "needs_setup"),
      ],
    }));
    expect(value.sources.map((source) => source.connections[0].state).sort()).toEqual([
      "accepted", "needs_setup", "quarantined", "rejected", "unsupported",
    ]);
    const drift = value.sources.find((source) => source.label === "quarantined")!.connections[0];
    expect(drift.drift).toMatchObject({ content: true, requiresReview: true, requiresPublish: true });
    expect(drift.tools[0].grantReadiness).toBe("needs_review");
  });

  it("rejects invalid identities and fences duplicate exact tuples", () => {
    const duplicate = discovery("account-a", "accepted");
    const value = projectLocalToolSources(inputs({
      discoveries: [
        duplicate,
        structuredClone(duplicate),
        discovery("invalid", "accepted", context(), hash("a"), hash("a"), "mcp shared"),
        discovery("valid", "accepted", context(), hash("a"), hash("a"), "mcp-shared"),
      ],
    }));
    const tools = value.sources.flatMap((source) =>
      source.connections.flatMap((connection) => connection.tools));
    const duplicates = tools.filter((tool) => tool.metadata.namespace === "mcp.shared");
    expect(duplicates).toHaveLength(2);
    expect(new Set(duplicates.map((tool) => tool.catalogId)).size).toBe(2);
    expect(duplicates.every((tool) => tool.identity === null
      && tool.reasonCode === "SOURCE_IDENTITY_COLLISION")).toBe(true);
    const invalid = tools.find((tool) => tool.metadata.namespace === "mcp shared")!;
    const valid = tools.find((tool) => tool.metadata.namespace === "mcp-shared")!;
    expect(invalid.identity).toBeNull();
    expect(valid.identity).toEqual({ source: "mcp-shared", key: "lookup" });
    expect(invalid.catalogId).not.toBe(valid.catalogId);
  });

  it("emits the canonical Backend/Web catalog contract", () => {
    const value = projectLocalToolSources(inputs({
      discoveries: [discovery("account-a", "accepted")],
    }));
    expect(LocalToolSourceCatalogSchema.parse(value)).toEqual(value);
  });

  it("fails closed when workspace and context project differ", () => {
    expect(() => projectLocalToolSources(inputs({
      workspace: { id: "project-b", hash: hash("d") },
    }))).toThrow("TOOL_SOURCE_CONTEXT_MISMATCH");
  });
});
