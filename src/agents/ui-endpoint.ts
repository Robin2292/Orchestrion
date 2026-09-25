import { randomUUID } from "node:crypto";
import { agentEndpoints } from "./endpoint";
import type { LocalAgentService } from "./service";
import {
  LocalAgentDetailSchema,
  LOCAL_AGENT_UI_MAX_ITEMS,
  LOCAL_AGENT_UI_PAGE_SIZE,
  LocalAgentUiRequestSchema,
  LocalAgentUiValueSchema,
  LocalAgentWorkspaceSchema,
  type LocalAgentUiReply,
} from "../shared/agent-ui-contracts";
import { LocalAgentSchema, LocalAgentVersionSchema } from "../shared/agent-contracts";
import { LOCAL_CONTRACT_VERSION, LocalVersionPinSchema, localFailure } from "../shared/local-contracts";
import { z } from "zod";
import type { LocalToolSourceCatalog } from "../shared/tool-source-contracts";
import type { ToolGrant } from "../shared/tool-grant-contracts";

type VersionPin = z.infer<typeof LocalVersionPinSchema>;
const commitResultSchema = z.object({ replayed: z.boolean(), resultRef: z.string().min(1).max(255) }).strict();

/** A1's renderer adapter. It accepts no org, project, principal, runtime owner,
 * SQL, path, execution, Tool or Policy inputs. The authenticated utility host
 * supplies A0's complete command envelope and delegates to the strict endpoint. */
export class LocalAgentUiEndpoint {
  constructor(private readonly resolve: () => LocalAgentService | null,
    private readonly resolveDirectAuthoring?: (service: LocalAgentService) => {
      catalog: LocalToolSourceCatalog;
      templates: { catalogId: string; grant: ToolGrant }[];
    }) {}

  invoke(raw: unknown, isActive: () => boolean): LocalAgentUiReply {
    const parsed = LocalAgentUiRequestSchema.safeParse(raw);
    if (!parsed.success) return localFailure("INVALID_PAYLOAD");
    if (!isActive()) return localFailure("NOT_AUTHENTICATED");
    const service = this.resolve();
    if (!service) return localFailure("SERVICE_UNAVAILABLE");
    const endpoints = agentEndpoints(() => isActive() ? service : null);

    const read = (command: string, payload: unknown) => JSON.stringify({
      ...service.authority(),
      schema_version: LOCAL_CONTRACT_VERSION,
      request_id: randomUUID(),
      idempotency_key: randomUUID(),
      command,
      payload,
    });
    const write = (command: string, payload: unknown, expected: VersionPin, requestId: string, idempotencyKey: string) =>
      JSON.stringify({
        ...service.authority(),
        expected,
        schema_version: LOCAL_CONTRACT_VERSION,
        request_id: requestId,
        idempotency_key: idempotencyKey,
        command,
        payload,
      });
    const failed = <T>(value: { ok: true; value: T } | Extract<LocalAgentUiReply, { ok: false }>): value is Extract<LocalAgentUiReply, { ok: false }> => !value.ok;
    const pages = <T>(load: (offset: number) => { ok: true; value: unknown } | Extract<LocalAgentUiReply, { ok: false }>, schema: z.ZodType<T>) => {
      const values: T[] = [];
      for (let offset = 0; offset <= LOCAL_AGENT_UI_MAX_ITEMS; offset += LOCAL_AGENT_UI_PAGE_SIZE) {
        const result = load(offset);
        if (failed(result)) return result;
        const page = z.array(schema).max(LOCAL_AGENT_UI_PAGE_SIZE).parse(result.value);
        if (offset === LOCAL_AGENT_UI_MAX_ITEMS)
          return page.length === 0 ? values : localFailure("SERVICE_UNAVAILABLE");
        values.push(...page);
        if (page.length < LOCAL_AGENT_UI_PAGE_SIZE) return values;
      }
      // Never return a silently incomplete ledger at the explicit UI bound.
      return localFailure("SERVICE_UNAVAILABLE");
    };

    const workspace = (): LocalAgentUiReply | ReturnType<typeof LocalAgentWorkspaceSchema.parse> => {
      const listedAgents = pages((offset) => endpoints.list(read("agent.list", {
        limit: LOCAL_AGENT_UI_PAGE_SIZE, offset,
      })), LocalAgentSchema);
      if (!Array.isArray(listedAgents)) return listedAgents;
      const agents = listedAgents.map((agent) => {
        if (!agent.latestVersionId) return { agent, latestVersion: null };
        const latest = endpoints.reference(read("agent.reference", { agentId: agent.id, versionId: agent.latestVersionId }));
        if (failed(latest)) return latest;
        return { agent, latestVersion: LocalAgentVersionSchema.parse(latest.value) };
      });
      const failure = agents.find((value): value is Extract<LocalAgentUiReply, { ok: false }> => "ok" in value && !value.ok);
      if (failure) return failure;
      const direct = this.resolveDirectAuthoring?.(service) ?? {
        catalog: { schemaVersion:"tool_source_catalog@1" as const, authority:"none" as const,
          orgId:service.context.org_id,sources:[] }, templates:[],
      };
      return LocalAgentWorkspaceSchema.parse({
        schemaVersion: "orchestrion.local.agent.ui.v3",
        projectId: service.context.project_id,
        expected: service.authority().expected,
        toolSourceCatalog: direct.catalog,
        toolGrantTemplates: direct.templates,
        agents,
      });
    };
    const detail = (agentId: string): LocalAgentUiReply | ReturnType<typeof LocalAgentDetailSchema.parse> => {
      const agent = endpoints.get(read("agent.get", { id: agentId }));
      if (failed(agent)) return agent;
      const versions = pages((offset) => endpoints.versions(read("agent.versions", {
        id: agentId, limit: LOCAL_AGENT_UI_PAGE_SIZE, offset,
      })), LocalAgentVersionSchema);
      if (!Array.isArray(versions)) return versions;
      return LocalAgentDetailSchema.parse({
        agent: LocalAgentSchema.parse(agent.value),
        versions,
      });
    };
    const success = (agentId: string | null, versionId: string | null): LocalAgentUiReply => {
      const nextWorkspace = workspace();
      if ("ok" in nextWorkspace) return nextWorkspace;
      const nextDetail = agentId ? detail(agentId) : null;
      if (nextDetail && "ok" in nextDetail) return nextDetail;
      return { ok: true, value: LocalAgentUiValueSchema.parse({ workspace: nextWorkspace, detail: nextDetail, selectedVersionId: versionId }) };
    };

    const request = parsed.data;
    if (request.operation === "snapshot") return success(null, null);
    if (request.operation === "detail") return success(request.agentId, null);
    if (request.operation === "create") {
      const result = endpoints.create(write("agent.create", request.payload, request.expected, request.requestId, request.idempotencyKey));
      return failed(result) ? result : success(commitResultSchema.parse(result.value).resultRef, null);
    }
    if (request.operation === "update") {
      const result = endpoints.update(write("agent.update", request.payload, request.expected, request.requestId, request.idempotencyKey));
      return failed(result) ? result : success(request.payload.id, null);
    }
    if (request.operation === "version.create") {
      const result = endpoints.createVersion(write("agent.version.create", request.payload, request.expected, request.requestId, request.idempotencyKey));
      return failed(result) ? result : success(request.payload.agentId, commitResultSchema.parse(result.value).resultRef);
    }
    const result = endpoints.delete(write("agent.delete", request.payload, request.expected, request.requestId, request.idempotencyKey));
    return failed(result) ? result : success(null, null);
  }
}
