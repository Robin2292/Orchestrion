import { PolicyRepository } from "../policies/repository";
import type { LocalPolicyService } from "../policies/service";
import { reviewedBuiltinCatalog } from "../tools/builtins/catalog";
import { projectLocalToolSources } from "../tools/source-catalog";
import type { ToolRegistry } from "../tools/registry";
import { grantDigest } from "./repository";
import { LocalFolderIdentitySchema } from "../shared/execution-attempt-contracts";
import {
  LocalToolContractVersionSchema,
  ToolGrantSchema,
  grantCanonicalJson,
  normalizeToolGrants,
  type ToolGrant,
  type ToolGrantSet,
} from "../shared/tool-grant-contracts";
import type { LocalToolSourceCatalog } from "../shared/tool-source-contracts";
import { canonical } from "../shared/policy/p0-canonical";
import type { PolicyRelease } from "../shared/policy/p1-contracts";
import type { SqliteFoundation } from "../storage/sqlite/foundation";
import {
  GOVERNED_FILE_READ_MAX_BYTES,
  GOVERNED_FILE_READ_TOOL,
  GOVERNED_GIT_TOOLS,
} from "../shared/governed-tool-contracts";
import {
  GOVERNED_GIT_MAX_OUTPUT_BYTES,
  GOVERNED_GIT_TIMEOUT_MS,
} from "../main/host-process-executor";

export interface LocalDirectAuthoringSnapshot {
  catalog: LocalToolSourceCatalog;
  templates: { catalogId: string; grant: ToolGrant }[];
}

function runtimeLimits(toolName: string): { output: number; runtime: number } | null {
  if (toolName === GOVERNED_FILE_READ_TOOL) {
    return { output: GOVERNED_FILE_READ_MAX_BYTES, runtime: 30 };
  }
  if ((GOVERNED_GIT_TOOLS as readonly string[]).includes(toolName)) {
    return {
      output: GOVERNED_GIT_MAX_OUTPUT_BYTES,
      runtime: Math.ceil(GOVERNED_GIT_TIMEOUT_MS / 1000),
    };
  }
  return null;
}

function resourceWithin(requested: string, ceiling: string): boolean {
  if (!requested || requested.includes("\0") || requested === ceiling) return requested === ceiling;
  if (ceiling.endsWith("/**")) {
    const base = ceiling.slice(0, -3).replace(/\/$/, "");
    return requested.startsWith(`${base}/`) && !requested.slice(base.length + 1).split("/").some((part) => part === "" || part === "." || part === "..");
  }
  if (ceiling.endsWith("/*")) {
    const base = ceiling.slice(0, -2).replace(/\/$/, "");
    const suffix = requested.startsWith(`${base}/`) ? requested.slice(base.length + 1) : "";
    return Boolean(suffix) && !suffix.includes("/") && suffix !== "." && suffix !== "..";
  }
  return false;
}

function withoutResource(grant: ToolGrant): unknown {
  return { ...grant, resource_scope: { ...grant.resource_scope, resource: "<resource>" } };
}

function policyResourceCeiling(
  release: PolicyRelease,
  workspaceDir: string,
): string | null {
  const workspaceCeiling = `${workspaceDir}/**`;
  const candidates = release.definition.rules.flatMap((rule) => {
    if (rule.resource_type !== "workspace_path" || rule.mode !== "read" || rule.decision === "deny") return [];
    if (rule.matcher.kind === "exact") {
      return resourceWithin(rule.matcher.value, workspaceCeiling) ? [rule.matcher.value] : [];
    }
    const ruleCeiling = `${rule.matcher.value}/**`;
    if (resourceWithin(workspaceDir, ruleCeiling) || workspaceDir === rule.matcher.value) return [workspaceCeiling];
    return resourceWithin(rule.matcher.value, workspaceCeiling) ? [ruleCeiling] : [];
  }).sort((left, right) => left.length - right.length || left.localeCompare(right));
  const broadest = candidates[0];
  return broadest && candidates.every((candidate) => resourceWithin(candidate, broadest))
    ? broadest
    : null;
}

/** Recompile the renderer submission against a fresh host snapshot. Catalog IDs
 * never cross this boundary; only an exact trusted template may vary by a
 * resource that is provably inside its published Policy ceiling. */
export function validateLocalAuthoredGrantSet(
  snapshot: LocalDirectAuthoringSnapshot,
  raw: ToolGrantSet | null,
): ToolGrantSet | null {
  if (raw === null) return null;
  const grants = normalizeToolGrants(raw);
  for (const grant of grants.grants) {
    const matches = snapshot.templates.filter((template) =>
      grantCanonicalJson(withoutResource(template.grant)) === grantCanonicalJson(withoutResource(grant))
      && template.grant.resource_scope.kind === grant.resource_scope.kind
      && resourceWithin(grant.resource_scope.resource, template.grant.resource_scope.resource));
    if (matches.length !== 1) throw new Error("TOOL_GRANT_DRAFT_UNRESOLVED");
  }
  return grants;
}

/** Trusted host projection for the Local editor. Catalog IDs only correlate UI
 * rows; every template is rebuilt from scoped contract + active Policy rows. */
export function localDirectAuthoringSnapshot(
  store: SqliteFoundation,
  registry: ToolRegistry,
  policies: LocalPolicyService,
): LocalDirectAuthoringSnapshot {
  const context = store.workspace;
  const state = store.transaction((tx) => {
    const scope = [context.org_id, context.project_id, context.principal.type, context.principal.id];
    const workspace = tx.get(`SELECT identity_json FROM local_session_tree_projects
      WHERE org_id=? AND project_id=? AND principal_type=? AND principal_id=?`, ...scope);
    if (!workspace) return null;
    const identity = LocalFolderIdentitySchema.parse(JSON.parse(String(workspace.identity_json)));
    const contracts = tx.all(`SELECT * FROM local_tool_contract_versions
      WHERE org_id=? AND project_id=? AND principal_type=? AND principal_id=?`, ...scope).map((row) =>
      LocalToolContractVersionSchema.parse({
        context,
        tool:{ source:row.source_namespace,key:row.tool_key },
        anchor:JSON.parse(String(row.anchor_json)),
        schema_hash:row.schema_hash,
        contract_json:row.contract_json,
      }));
    const repository = new PolicyRepository(tx, context);
    repository.authorize();
    const releases = repository.list();
    const activeReleaseIds = new Set(releases.flatMap((release) => {
      const latest = repository.latest(release.bindingId);
      return latest?.releaseId === release.id ? [release.id] : [];
    }));
    return { identity, contracts, releases, activeReleaseIds };
  });
  if (!state) return {
    catalog: { schemaVersion:"tool_source_catalog@1",authority:"none",orgId:context.org_id,sources:[] },
    templates: [],
  };
  const registered = registry.list(context);
  const catalog = projectLocalToolSources({
    context,
    workspace:{ id:context.project_id,hash:grantDigest(state.identity) },
    builtins:reviewedBuiltinCatalog(),
    registered,
    contracts:state.contracts,
    discoveries:[],
  });
  const templates: { catalogId:string;grant:ToolGrant }[] = [];
  for (const source of catalog.sources) for (const connection of source.connections) for (const tool of connection.tools) {
      if (tool.grantReadiness !== "ready" || tool.state !== "accepted" || !tool.identity || !tool.selection || !tool.contract) continue;
      const definition = registered.find((item) => item.connectorId === tool.identity!.source && item.name === tool.identity!.key);
      const contract = state.contracts.find((item) => item.anchor.tool_contract_version_id === tool.contract!.versionId
        && item.anchor.tool_contract_hash === tool.contract!.contractHash);
      if (!definition || !contract) continue;
      const active = state.releases.filter((release) => release.target.layer === "organization"
        && release.toolName === definition.name && release.lifecycle === "published"
        && canonical(release.toolAnchor) === canonical(contract.anchor)
        && state.activeReleaseIds.has(release.id));
      if (active.length !== 1) continue;
      let summary;
      try {
        summary = policies.activeSummary({ target:{ layer:"organization" },toolName:definition.name,
          sourceId:definition.sourceId,connectorId:definition.connectorId,connectionId:definition.connectionId,
          toolAnchor:contract.anchor });
      } catch { continue; }
      if (!summary) continue;
      const limits = runtimeLimits(definition.name);
      const workspaceDir = summary.effectiveScope.workspace_dir;
      if (!limits || typeof workspaceDir !== "string" || !workspaceDir.startsWith("/") || workspaceDir.endsWith("/")) continue;
      const resourceCeiling = policyResourceCeiling(active[0],workspaceDir);
      if (!resourceCeiling) continue;
      const selection = tool.selection;
      const grant = ToolGrantSchema.parse({
        tool:tool.identity,
        contract:{ id:tool.contract.versionId,hash:tool.contract.contractHash },
        connection:selection.connection ? { kind:selection.connection.kind,id:selection.connection.id,authority_hash:selection.connection.authorityHash } : null,
        execution_target:selection.executionTarget ? { kind:selection.executionTarget.kind,id:selection.executionTarget.id,
          placement:selection.executionTarget.placement,workspace_hash:selection.executionTarget.workspaceHash } : null,
        resource_scope:{ kind:"workspace_path",resource:resourceCeiling },
        // Runtime-supported reviewed built-ins have an immutable read-only
        // contract. Catalog-declared effects remain display-only correlation.
        constraints:{ effects:["read"],argument_schema_hash:contract.schema_hash,
          max_output_bytes:limits.output,max_runtime_seconds:limits.runtime },
        policy:{ id:active[0].id,hash:active[0].releaseHash },
        approval:null,
      });
      templates.push({ catalogId:tool.catalogId,grant });
  }
  return { catalog,templates };
}
