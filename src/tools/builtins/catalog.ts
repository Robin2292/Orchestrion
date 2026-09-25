import type { LocalReviewedToolDescriptor } from "../../shared/tool-source-contracts";
import { LocalReviewedToolDescriptorSchema } from "../../shared/tool-source-contracts";
import type { ToolParameterSchema } from "../../shared/tool-registry-contracts";
import type { ToolDefinition } from "../../shared/tool-registry-contracts";
import { canonicalToolProjection } from "../../shared/tool-projection";
import {
  FILE_READ_DESCRIPTION,
  FILE_READ_PARAMETERS,
  GOVERNED_FILE_READ_CONNECTION,
  GOVERNED_FILE_READ_CONNECTOR,
  GOVERNED_FILE_READ_IMPLEMENTATION,
  GOVERNED_FILE_READ_TOOL,
  GOVERNED_GIT_CONNECTION,
  GOVERNED_GIT_CONNECTOR,
  GOVERNED_GIT_TOOLS,
  gitToolContract,
} from "../../shared/governed-tool-contracts";
import { ToolRegistryError, toolDigest } from "../registry";

type DescriptorBody = Omit<LocalReviewedToolDescriptor, "contractHash" | "source" | "authority">;

function descriptorBody(value: Pick<LocalReviewedToolDescriptor,"name" | "description" | "connectorId" | "connectionId" | "parameters" | "outputSchema" | "implementationId" | "implementationVersion">): DescriptorBody {
  return {
    name:value.name,description:value.description,connectorId:value.connectorId,connectionId:value.connectionId,
    parameters:structuredClone(value.parameters),outputSchema:structuredClone(value.outputSchema),
    implementationId:value.implementationId,implementationVersion:value.implementationVersion,
  };
}

/** Independent reviewed snapshot. A change to the executable declaration does
 * not silently change what a fresh profile can configure: review must update
 * this snapshot in the same commit or catalog projection fails closed. */
const REVIEWED: readonly DescriptorBody[] = [{
  name: "file.read",
  description: "Governed read-only access to one UTF-8 text file (at most 256 KiB) inside the current project folder. Pass a path relative to the project root. Secret-bearing files (.env*, credentials, private keys, .git internals) and anything outside the project are always refused.",
  connectorId: "orchestrion.builtin.file",
  connectionId: "local-workspace",
  parameters: {
    type: "object",
    description: "Read one UTF-8 text file inside the session's project folder.",
    properties: { path: { type: "string", description: "File path relative to the project root, using forward slashes (for example src/index.ts). Absolute paths, .., and secret-bearing locations are refused." } },
    required: ["path"],
    additionalProperties: false,
  },
  outputSchema: null,
  implementationId: "orchestrion.builtin.file.read",
  implementationVersion: "v1",
}, {
  name: "git.status",
  description: "Governed read-only Git status for the current project. No shell, repository mutation, credentials or network are available.",
  connectorId: "orchestrion.builtin.git",
  connectionId: "local-workspace",
  parameters: { type: "object", description: "No arguments.", properties: {}, required: [], additionalProperties: false },
  outputSchema: null,
  implementationId: "orchestrion.builtin.git.status",
  implementationVersion: "v1",
}, {
  name: "git.diff",
  description: "Governed bounded Git patch for exactly one non-secret workspace file. Pathspec expansion, external diff and text conversion are disabled.",
  connectorId: "orchestrion.builtin.git",
  connectionId: "local-workspace",
  parameters: {
    type: "object",
    description: "Show a bounded patch for exactly one workspace-relative file.",
    properties: {
      path: { type: "string", description: "One literal workspace-relative file path. Git pathspec patterns are not expanded." },
      cached: { type: "boolean", description: "Compare the index with HEAD. Cannot be combined with revision." },
      revision: { type: "string", description: "One non-option revision name to compare with the working tree. Ranges are refused." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  outputSchema: null,
  implementationId: "orchestrion.builtin.git.diff",
  implementationVersion: "v1",
}, {
  name: "git.log",
  description: "Governed bounded Git commit metadata from HEAD. Revisions, patches, signatures and external helpers are unavailable.",
  connectorId: "orchestrion.builtin.git",
  connectionId: "local-workspace",
  parameters: {
    type: "object",
    description: "Show bounded commit metadata from HEAD.",
    properties: {
      max_count: { type: "integer", description: "Maximum commits, from 1 through 50." },
      format: { type: "string", enum: ["oneline", "detailed"], description: "Bounded metadata format." },
    },
    required: [],
    additionalProperties: false,
  },
  outputSchema: null,
  implementationId: "orchestrion.builtin.git.log",
  implementationVersion: "v1",
}] as const;

function derived(): DescriptorBody[] {
  const file: DescriptorBody = {
    name: GOVERNED_FILE_READ_TOOL,
    description: FILE_READ_DESCRIPTION,
    connectorId: GOVERNED_FILE_READ_CONNECTOR,
    connectionId: GOVERNED_FILE_READ_CONNECTION,
    parameters: structuredClone(FILE_READ_PARAMETERS),
    outputSchema: null,
    implementationId: GOVERNED_FILE_READ_IMPLEMENTATION.id,
    implementationVersion: GOVERNED_FILE_READ_IMPLEMENTATION.version,
  };
  const git = GOVERNED_GIT_TOOLS.map((name): DescriptorBody => {
    const contract = gitToolContract(name);
    return { name, description: contract.description, connectorId: GOVERNED_GIT_CONNECTOR, connectionId: GOVERNED_GIT_CONNECTION,
      parameters: structuredClone(contract.parameters) as ToolParameterSchema, outputSchema: null,
      implementationId: contract.implementation.id, implementationVersion: contract.implementation.version };
  });
  return [file, ...git];
}

/** Returns data only. No ToolRegistry, Connector, Tool contract, Policy, grant,
 * attempt, grant, planner or adapter is created or registered here. */
export function reviewedBuiltinCatalog(candidate: readonly DescriptorBody[] = derived()): LocalReviewedToolDescriptor[] {
  if (canonicalToolProjection(candidate) !== canonicalToolProjection(REVIEWED)) throw new ToolRegistryError("TOOL_SCHEMA_DRIFT", "refresh");
  return REVIEWED.map((body) => LocalReviewedToolDescriptorSchema.parse({
    ...structuredClone(body),
    contractHash: toolDigest(["orchestrion.reviewed-builtin.catalog.v1", body]),
    source: "reviewed_builtin",
    authority: "none",
  }));
}

/** Host-side validation for injected/composed catalog providers.  Exact array
 * equality refuses reordered duplicates, omissions, unknown names and every
 * descriptor or fingerprint drift before the catalog reaches the renderer. */
export function validateReviewedBuiltinCatalog(raw: readonly LocalReviewedToolDescriptor[]): LocalReviewedToolDescriptor[] {
  const parsed=raw.map((value) => LocalReviewedToolDescriptorSchema.parse(value));
  const reviewed=reviewedBuiltinCatalog();
  if (canonicalToolProjection(parsed) !== canonicalToolProjection(reviewed))
    throw new ToolRegistryError("TOOL_SCHEMA_DRIFT","refresh");
  return parsed.map((value) => structuredClone(value));
}

export function reviewedBuiltinIdentity(definition: ToolDefinition,descriptor: LocalReviewedToolDescriptor): boolean {
  return definition.name === descriptor.name && definition.connectorId === descriptor.connectorId
    && definition.connectionId === descriptor.connectionId && definition.implementationId === descriptor.implementationId
    && definition.implementationVersion === descriptor.implementationVersion;
}

/** Full reviewed semantics, not just adapter identity.  The descriptor's hash
 * and all declaration fields are checked through the same canonical Tool
 * projection used by ToolRegistry hashing. */
export function reviewedBuiltinDefinitionMatches(definition: ToolDefinition,descriptor: LocalReviewedToolDescriptor): boolean {
  if (!reviewedBuiltinIdentity(definition,descriptor)) return false;
  const body=descriptorBody(definition);
  return canonicalToolProjection(body) === canonicalToolProjection(descriptorBody(descriptor))
    && descriptor.contractHash === toolDigest(["orchestrion.reviewed-builtin.catalog.v1",body]);
}
