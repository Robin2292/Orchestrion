import { z } from "zod";
import { endpointUrl } from "../connectors/http-transport";
import type { LocalConnector } from "../shared/connector-contracts";
import { ToolParameterSchemaSchema } from "../shared/tool-registry-contracts";
import { toolDigest, toolJson } from "../tools/registry";
import { StorageError } from "../storage/sqlite/foundation";
import type { SourceCandidate } from "../shared/source-publication-contracts";
import type { SourcePublication } from "../shared/source-publication-contracts";
import type { HostConnectorHttpService } from "../connectors/http-service";
import { ConnectorRepository } from "../connectors/repository";
import type { SqliteFoundation } from "../storage/sqlite/foundation";
import type { LocalContext } from "../shared/local-contracts";
import type { SourceDiscoveryAuthority } from "./service";
import type { ToolImplementation } from "../tools/registry";

const name = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/);
const entry = z.object({ name, description:z.string().max(8192).optional(),
  method:z.literal("GET").optional(),path:z.string().regex(/^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/),
  parameters:z.record(name,z.never()).optional() }).strict();
const fields = { name, description:z.string().max(8192).optional(),base_url:z.string().min(1).max(1000) };
const input = z.object({
  source:z.object({origin:z.string().min(1).max(1000),id:name,version:name}).strict(),
  definition:z.union([z.object({...fields,tools:z.array(entry).length(1)}).strict(),
    z.object({...fields,capabilities:z.array(entry).length(1)}).strict()]),
  // Historical input is read for compatibility; no Toolset scope is written or
  // promoted to an M8 direct grant.
  scope:z.unknown().optional(),toolScopes:z.unknown().optional(),
}).strict();

export function httpEndpointResource(url:string):string {
  return toolDigest(["declarative-http-get-endpoint-v1",endpointUrl(url).href]);
}
export function httpResourceFromKey(key:string):string|null {
  const match=/^[A-Za-z][A-Za-z0-9_.-]{0,127}\.h([0-9a-f]{64})\.v[0-9a-f]{16}$/.exec(key);
  return match ? `sha256:${match[1]}` : null;
}
/** Narrow, effectless legacy `capabilities` reader and canonical `tools` writer.
 * Only an exact static GET on the host-owned Connection endpoint is supported.
 * Unsupported methods, templates, parameters, headers and credentials fail closed.
 */
export function importDeclarativeHttpGet(raw:unknown,connector:LocalConnector):{
  candidate:SourceCandidate; endpoint:string; resource:string; contractHash:string;
} {
  try {
    const parsed=input.parse(JSON.parse(toolJson(raw)));
    if (connector.deletedAt || connector.origin!=="local" || connector.config.transport!=="http") throw new Error();
    const base=endpointUrl(parsed.definition.base_url.endsWith("/")
      ? parsed.definition.base_url : `${parsed.definition.base_url}/`);
    if (endpointUrl(parsed.source.origin).origin!==base.origin) throw new Error();
    const tool=("tools" in parsed.definition ? parsed.definition.tools : parsed.definition.capabilities)[0];
    if (tool.parameters && Object.keys(tool.parameters).length) throw new Error();
    const endpoint=endpointUrl(`${base.href.replace(/\/$/,"")}${tool.path}`).href;
    if (endpoint!==connector.config.url || new URL(endpoint).origin!==base.origin) throw new Error();
    const resource=httpEndpointResource(endpoint);
    const version=toolDigest([parsed.source,parsed.definition]).slice(7,23);
    const key=`${tool.name}.h${resource.slice(7)}.v${version}`;
    const empty=ToolParameterSchemaSchema.parse({type:"object",properties:{},required:[],additionalProperties:false});
    const candidate:SourceCandidate={ connectorId:connector.id,connectorRevision:connector.revision,
      adapterKind:"declarative_http_get",status:"candidate",tools:[{key,inputSchema:empty,outputSchema:null}] };
    return {candidate,endpoint,resource,contractHash:toolDigest([parsed.source,endpoint,candidate])};
  } catch { throw new StorageError("HTTP_IMPORT_INVALID"); }
}

/** Trusted host composition only. The legacy proposal is normalized once, then
 * reparsed against the live Connection on every Source/Policy preflight. */
export function declarativeHttpSourceDiscovery(store:SqliteFoundation,context:LocalContext,
  http:HostConnectorHttpService,raw:unknown):SourceDiscoveryAuthority {
  const wire=toolJson(raw);
  const current=(id:string,revision:number)=>store.transaction(tx=>{
    const row=new ConnectorRepository(tx,context).get(id);
    if (row.revision!==revision) throw new StorageError("SOURCE_DRIFT");
    const imported=importDeclarativeHttpGet(JSON.parse(wire),row);
    if (!http.reviewedGetForConnector(row,imported.endpoint)) throw new StorageError("SOURCE_PROFILE_NOT_READY");
    return imported.candidate;
  });
  return { candidate:current,
    reviewedProfile:(id,revision)=>{try {current(id,revision);return true;}catch{return false;}},
    reviewedProfileForConnector:(row)=>{
      try { const imported=importDeclarativeHttpGet(JSON.parse(wire),row);
        return http.reviewedGetForConnector(row,imported.endpoint); } catch { return false; }
    } };
}

/** Reviewed executable binding. Source publication and direct grants remain the
 * authority; registering this implementation alone cannot make a call ready. */
export function declarativeHttpGetImplementation(context:LocalContext,publication:SourcePublication,
  endpoint:string,http:HostConnectorHttpService):ToolImplementation {
  const resource=httpEndpointResource(endpoint);
  const tool=publication.tools.find(t=>httpResourceFromKey(t.key)===resource);
  if (publication.adapterKind!=="declarative_http_get" || !tool || publication.tools.length!==1
    || publication.sourceId!==publication.connectionId) throw new StorageError("SOURCE_DRIFT");
  const definition={context,sourceId:publication.sourceId,connectorId:publication.sourceId,
    connectionId:publication.connectionId,name:tool.key,description:"Reviewed static HTTP GET",
    parameters:tool.inputSchema,outputSchema:tool.outputSchema,implementationId:"declarative-http-get-v1",
    implementationVersion:tool.contractId,policyMode:"external" as const};
  return {describe:()=>structuredClone(definition),
    planningReview:{version:"declarative-http-get-v1",effect:"read_only",resourceKind:"http_endpoint"},
    planner:()=>({arguments:{},claims:[{type:"http_endpoint",value:resource,mode:"read"}]}),
    adapter:((maxBytes:number,beforeDispatch:()=>void,signal:AbortSignal)=>
      http.readOnlyGet({id:publication.sourceId,revision:publication.pin.connectorRevision},
        endpoint,maxBytes,beforeDispatch,signal)) as ToolImplementation["adapter"]};
}
