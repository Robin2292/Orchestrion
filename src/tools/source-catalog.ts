/** Source-oriented, authority-free projection of Local Tool metadata. */
import type { LocalContext } from "../shared/local-contracts";
import { LocalContextSchema } from "../shared/local-contracts";
import type { LocalToolContractVersion } from "../shared/tool-grant-contracts";
import { LocalToolContractVersionSchema } from "../shared/tool-grant-contracts";
import type { ToolDefinition } from "../shared/tool-registry-contracts";
import type { LocalReviewedToolDescriptor } from "../shared/tool-source-contracts";
import {
  LocalSourceDiscoverySchema,
  LocalToolSourceCatalogSchema,
  type LocalSourceDiscovery,
  type LocalToolSourceCatalog,
} from "../shared/tool-source-contracts";
import { canonicalToolProjection } from "../shared/tool-projection";
import { reviewedBuiltinDefinitionMatches } from "./builtins/catalog";
import { toolAnchor, toolDigest } from "./registry";

const noDrift = {
  content: false,
  schema: false,
  executor: false,
  contract: false,
  requiresReview: false,
  requiresPublish: false,
} as const;
const noReview = {
  latestSnapshotId: null,
  acceptedSnapshotId: null,
  acceptedContentDigest: null,
  latestContentDigest: null,
  publishedRevision: null,
  activeRevision: null,
  rollbackRevision: null,
} as const;
const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

const effects = (name: string, readonly: boolean) => readonly
  ? ["read"] as const
  : /delete|remove/i.test(name)
    ? ["delete"] as const
    : /execute|run/i.test(name)
      ? ["execute"] as const
      : ["write"] as const;

function sameContext(left: LocalContext, right: LocalContext): boolean {
  return canonicalToolProjection(left) === canonicalToolProjection(right);
}

function identity(source: string, key: string) {
  return source.length <= 255 && key.length <= 255
    && identityPattern.test(source) && identityPattern.test(key)
    ? { source, key }
    : null;
}

function exactContract(
  definition: ToolDefinition,
  contracts: readonly LocalToolContractVersion[],
): LocalToolContractVersion | null | "collision" {
  const expected = toolAnchor(definition);
  const candidates = contracts.filter((contract) =>
    sameContext(contract.context, definition.context)
    && contract.anchor.owner_key === expected.owner_key
    && contract.anchor.tool_name === expected.tool_name);
  if (candidates.length > 1) return "collision";
  if (candidates.length === 0) return null;
  const contract = candidates[0];
  return contract.anchor.tool_contract_version_id === expected.tool_contract_version_id
    && contract.anchor.tool_contract_hash === expected.tool_contract_hash
    && contract.tool.source === definition.connectorId
    && contract.tool.key === definition.name
    && contract.contract_json === canonicalToolProjection(definition)
    ? contract
    : "collision";
}

type Source = LocalToolSourceCatalog["sources"][number];
type Connection = Source["connections"][number];
type Tool = Connection["tools"][number];

function add(
  sources: Map<string, Source>,
  source: Omit<Source, "connections">,
  connection: Omit<Connection, "tools">,
  tool: Tool,
): void {
  const sourceKey = canonicalToolProjection([
    source.namespace,
    source.kind,
    source.label,
  ]);
  let currentSource = sources.get(sourceKey);
  if (!currentSource) {
    currentSource = { ...source, connections: [] };
    sources.set(sourceKey, currentSource);
  }
  const connectionKey = canonicalToolProjection([
    connection.selection,
    connection.label,
  ]);
  let currentConnection = currentSource.connections.find((value) =>
    canonicalToolProjection([value.selection, value.label]) === connectionKey);
  if (!currentConnection) {
    currentConnection = { ...connection, tools: [] };
    currentSource.connections.push(currentConnection);
  }
  currentConnection.tools.push(tool);
}

function fenceCollisions(sources: Source[]): void {
  const tuples = new Map<string, { connection: Connection; tool: Tool }[]>();
  for (const source of sources) {
    for (const connection of source.connections) {
      for (const tool of connection.tools) {
        if (!tool.identity) continue;
        const key = canonicalToolProjection([
          tool.identity,
          tool.selection,
        ]);
        tuples.set(key, [...(tuples.get(key) ?? []), { connection, tool }]);
      }
    }
  }
  for (const matches of tuples.values()) {
    if (matches.length < 2) continue;
    matches.sort((left, right) =>
      left.tool.metadata.metadataDigest.localeCompare(right.tool.metadata.metadataDigest));
    matches.forEach(({ connection, tool }, index) => {
      tool.catalogId = toolDigest([
        "orchestrion.local.tool-source-collision.v1",
        tool.catalogId,
        tool.metadata.metadataDigest,
        index,
      ]);
      tool.identity = null;
      tool.state = "quarantined";
      tool.reasonCode = "SOURCE_IDENTITY_COLLISION";
      tool.drift = {
        ...tool.drift,
        contract: true,
        requiresReview: true,
        requiresPublish: true,
      };
      tool.grantReadiness = "needs_review";
      connection.state = "quarantined";
      connection.reasonCode = "SOURCE_IDENTITY_COLLISION";
      connection.drift = {
        ...connection.drift,
        contract: true,
        requiresReview: true,
        requiresPublish: true,
      };
    });
  }
}

export interface LocalToolSourceInputs {
  context: LocalContext;
  workspace: { id: string; hash: string };
  builtins: readonly LocalReviewedToolDescriptor[];
  registered: readonly ToolDefinition[];
  contracts: readonly LocalToolContractVersion[];
  discoveries: readonly LocalSourceDiscovery[];
}

/** Creates no registry/connector/Tool contract/policy/grant and exposes no callable.
 * Plugin/Skill/model metadata remains an untrusted authority:none annotation. */
export function projectLocalToolSources(raw: LocalToolSourceInputs): LocalToolSourceCatalog {
  const context = LocalContextSchema.parse(raw.context);
  if (raw.workspace.id !== context.project_id) {
    throw new Error("TOOL_SOURCE_CONTEXT_MISMATCH");
  }
  const definitions = raw.registered.filter((definition) =>
    sameContext(definition.context, context));
  const contracts = raw.contracts
    .map((contract) => LocalToolContractVersionSchema.parse(contract))
    .filter((contract) => sameContext(contract.context, context));
  const discoveries = raw.discoveries
    .map((discovery) => LocalSourceDiscoverySchema.parse(discovery))
    .filter((discovery) => sameContext(discovery.context, context));
  const target = {
    connection: null,
    executionTarget: {
      kind: "local_workspace" as const,
      id: raw.workspace.id,
      placement: "local_trusted" as const,
      workspaceHash: raw.workspace.hash,
    },
  };
  const sources = new Map<string, Source>();
  const builtinIdentities = new Set(raw.builtins.map((item) =>
    canonicalToolProjection([item.connectorId, item.connectionId, item.name])));

  for (const descriptor of raw.builtins) {
    const inventory = definitions.filter((definition) =>
      definition.connectorId === descriptor.connectorId
      && definition.connectionId === descriptor.connectionId
      && definition.name === descriptor.name);
    const definition = inventory.length === 1 ? inventory[0] : null;
    const persisted = definition ? exactContract(definition, contracts) : null;
    const reviewed = definition
      ? reviewedBuiltinDefinitionMatches(definition, descriptor)
      : false;
    const collision = inventory.length > 1 || persisted === "collision";
    const exact = persisted && persisted !== "collision" ? persisted : null;
    const toolIdentity = exact
      ? identity(exact.tool.source, exact.tool.key)
      : identity(descriptor.connectorId, descriptor.name);
    const state = collision || (definition && !reviewed)
      ? "quarantined" as const
      : definition
        ? "accepted" as const
        : "needs_setup" as const;
    const reasonCode = collision
      ? "SOURCE_IDENTITY_COLLISION"
      : definition && !reviewed
        ? "LOCAL_BUILTIN_CONTRACT_DRIFT"
        : !definition
          ? "LOCAL_BUILTIN_NOT_REGISTERED"
          : exact
            ? "LOCAL_IMMUTABLE_CONTRACT_ACCEPTED"
            : "LOCAL_CONTRACT_PUBLISH_REQUIRED";
    const metadata = {
      name: descriptor.name,
      description: descriptor.description,
      namespace: toolIdentity?.source ?? descriptor.connectorId,
      inputSchema: { ...descriptor.parameters },
      outputSchema: descriptor.outputSchema ? { ...descriptor.outputSchema } : null,
      claimedEffects: ["read" as const],
      claimedRisk: "low" as const,
      annotations: {
        reviewedBuiltin: true,
        reviewedDescriptorDigest: descriptor.contractHash,
      },
      trust: "reviewed" as const,
      metadataDigest: toolDigest([
        descriptor.name,
        descriptor.description,
        descriptor.parameters,
        descriptor.outputSchema,
      ]),
    };
    const drift = collision || (definition && !reviewed)
      ? {
          ...noDrift,
          schema: true,
          executor: true,
          contract: true,
          requiresReview: true,
          requiresPublish: true,
        }
      : noDrift;
    const contract = exact ? {
      versionId: exact.anchor.tool_contract_version_id,
      contractHash: exact.anchor.tool_contract_hash,
      schemaHash: exact.schema_hash,
      executorHash: toolDigest([
        "immutable-contract-executor.v1",
        JSON.parse(exact.contract_json).implementationId,
        JSON.parse(exact.contract_json).implementationVersion,
      ]),
      declaredEffects: ["read" as const],
      // The Local TG1 anchor pins executable bytes but has no independently
      // attested physical-I/O profile. A reviewed label is not such proof.
      physicalReadonlyProven: false,
    } : null;
    const readiness = state === "quarantined"
      ? "needs_review" as const
      : !definition
        ? "needs_setup" as const
        : exact
          ? "ready" as const
          : "needs_publish" as const;
    const namespace = toolIdentity?.source ?? descriptor.connectorId;
    add(
      sources,
      { namespace, kind: "builtin", label: namespace, authority: "none" },
      {
        selection: target,
        label: "Local workspace",
        state,
        reasonCode,
        credentialReadiness: "not_required",
        review: noReview,
        drift,
      },
      {
        catalogId: toolDigest([
          context,
          namespace,
          descriptor.connectionId,
          descriptor.name,
          target,
        ]),
        identity: collision ? null : toolIdentity,
        selection: target,
        metadata,
        state: toolIdentity ? state : "quarantined",
        reasonCode: toolIdentity ? reasonCode : "SOURCE_IDENTITY_INVALID",
        authority: "none",
        contract,
        drift,
        grantReadiness: toolIdentity ? readiness : "needs_review",
      },
    );
  }

  for (const definition of definitions) {
    if (builtinIdentities.has(canonicalToolProjection([
      definition.connectorId,
      definition.connectionId,
      definition.name,
    ]))) continue;
    const persisted = exactContract(definition, contracts);
    const exact = persisted && persisted !== "collision" ? persisted : null;
    const collision = persisted === "collision";
    const toolIdentity = exact
      ? identity(exact.tool.source, exact.tool.key)
      : identity(definition.connectorId, definition.name);
    const namespace = toolIdentity?.source ?? definition.connectorId;
    const kind = /database/i.test(definition.connectorId)
      ? "database" as const
      : /mcp/i.test(definition.connectorId)
        ? "mcp" as const
        : /http/i.test(definition.connectorId)
          ? "http" as const
          : "http" as const;
    const unsupported = !/(database|mcp|http)/i.test(definition.connectorId);
    const state = collision
      ? "quarantined" as const
      : unsupported
        ? "unsupported" as const
        : "accepted" as const;
    const reasonCode = collision
      ? "SOURCE_IDENTITY_COLLISION"
      : unsupported
        ? "LOCAL_SOURCE_UNSUPPORTED"
        : exact
          ? "LOCAL_IMMUTABLE_CONTRACT_ACCEPTED"
          : "LOCAL_CONTRACT_PUBLISH_REQUIRED";
    const metadata = {
      name: definition.name,
      description: definition.description,
      namespace,
      inputSchema: { ...definition.parameters },
      outputSchema: definition.outputSchema ? { ...definition.outputSchema } : null,
      claimedEffects: [...effects(definition.name, false)],
      claimedRisk: "unknown" as const,
      annotations: { policyMode: definition.policyMode },
      trust: "untrusted" as const,
      metadataDigest: toolDigest([
        definition.name,
        definition.description,
        definition.parameters,
        definition.outputSchema,
      ]),
    };
    const drift = collision
      ? { ...noDrift, contract: true, requiresReview: true, requiresPublish: true }
      : { ...noDrift, requiresPublish: exact === null };
    add(
      sources,
      { namespace, kind, label: namespace, authority: "none" },
      {
        selection: target,
        label: definition.connectionId,
        state,
        reasonCode,
        credentialReadiness: "unknown",
        review: noReview,
        drift,
      },
      {
        catalogId: toolDigest([
          context,
          namespace,
          definition.connectionId,
          definition.name,
        ]),
        identity: collision ? null : toolIdentity,
        selection: target,
        metadata,
        state: toolIdentity ? state : "quarantined",
        reasonCode: toolIdentity ? reasonCode : "SOURCE_IDENTITY_INVALID",
        authority: "none",
        contract: exact ? {
          versionId: exact.anchor.tool_contract_version_id,
          contractHash: exact.anchor.tool_contract_hash,
          schemaHash: exact.schema_hash,
          executorHash: toolDigest([
            "immutable-contract-executor.v1",
            definition.implementationId,
            definition.implementationVersion,
          ]),
          declaredEffects: [...effects(definition.name, false)],
          physicalReadonlyProven: false,
        } : null,
        drift,
        grantReadiness: !toolIdentity || collision
          ? "needs_review"
          : unsupported
            ? "unsupported"
            : !exact
              ? "needs_publish"
              : "ready",
      },
    );
  }

  for (const discovery of discoveries) {
    const contentDrift = discovery.contentDigest
      !== discovery.acceptedContentDigest;
    const selection = discovery.connection ? {
      connection: {
        kind: discovery.kind === "database"
          ? "database" as const
          : discovery.kind === "mcp"
            ? "mcp_server" as const
            : "local_connector" as const,
        id: discovery.connection.id,
        authorityHash: discovery.connection.authorityHash,
      },
      executionTarget: null,
    } : null;
    const needsReview = discovery.state === "quarantined"
      || discovery.state === "rejected" || contentDrift;
    for (const item of discovery.tools) {
      const toolIdentity = identity(discovery.namespace, item.key);
      const state = toolIdentity ? discovery.state : "quarantined" as const;
      const reasonCode = toolIdentity
        ? discovery.reasonCode
        : "SOURCE_IDENTITY_INVALID";
      const metadata = {
        name: item.name,
        description: item.description,
        namespace: discovery.namespace,
        inputSchema: { ...item.inputSchema },
        outputSchema: item.outputSchema ? { ...item.outputSchema } : null,
        claimedEffects: [...effects(item.name, false)],
        claimedRisk: "unknown" as const,
        annotations: item.annotations,
        trust: "untrusted" as const,
        metadataDigest: toolDigest([
          item.name,
          item.description,
          item.inputSchema,
          item.outputSchema,
          item.annotations,
        ]),
      };
      const drift = {
        ...noDrift,
        content: contentDrift,
        requiresReview: needsReview || !toolIdentity,
        requiresPublish: true,
      };
      add(
        sources,
        {
          namespace: discovery.namespace,
          kind: discovery.kind,
          label: discovery.label,
          authority: "none",
        },
        {
          selection,
          label: discovery.label,
          state,
          reasonCode,
          credentialReadiness: discovery.credentialReadiness,
          review: {
            ...noReview,
            latestContentDigest: discovery.contentDigest,
            acceptedContentDigest: discovery.acceptedContentDigest,
          },
          drift,
        },
        {
          catalogId: toolDigest([
            context,
            discovery.namespace,
            discovery.connection?.id,
            item.key,
            metadata.metadataDigest,
          ]),
          identity: toolIdentity,
          selection,
          metadata,
          state,
          reasonCode,
          authority: "none",
          contract: null,
          drift,
          grantReadiness: !toolIdentity || needsReview
            ? "needs_review"
            : discovery.state === "unsupported"
              ? "unsupported"
              : discovery.state === "needs_setup" || !selection
                ? "needs_setup"
                : "needs_publish",
        },
      );
    }
  }

  const result = [...sources.values()];
  fenceCollisions(result);
  for (const source of result) {
    source.connections.sort((left, right) =>
      canonicalToolProjection([left.label, left.selection])
        .localeCompare(canonicalToolProjection([right.label, right.selection])));
    for (const connection of source.connections) {
      connection.tools.sort((left, right) =>
        left.catalogId.localeCompare(right.catalogId));
    }
  }
  result.sort((left, right) =>
    canonicalToolProjection([left.kind, left.namespace, left.label])
      .localeCompare(canonicalToolProjection([right.kind, right.namespace, right.label])));
  return LocalToolSourceCatalogSchema.parse({
    schemaVersion: "tool_source_catalog@1",
    authority: "none",
    orgId: context.org_id,
    sources: result,
  });
}
