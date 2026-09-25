import { z } from "zod";
import { LOCAL_CONTRACT_VERSION, LocalVersionPinSchema, localFailure } from "../shared/local-contracts";
import { exactPath } from "../shared/policy/p0-canonical";
import {
  LocalPolicyReleaseViewSchema,
  LocalPolicyUiItemSchema,
  LocalPolicyUiRejectionCodeSchema,
  LocalPolicyUiRequestSchema,
  LocalPolicyUiValueSchema,
  LocalPolicyUiWorkspaceSchema,
  type LocalPolicyUiItem,
  type LocalPolicyUiReply,
  type LocalPolicySimulationView,
} from "../shared/policy/p2-ui-contracts";
import type { PolicyRelease } from "../shared/policy/p1-contracts";
import { StorageError } from "../storage/sqlite/foundation";
import { canonical } from "../shared/policy/p0-canonical";
import type { LocalPolicyService } from "./service";

type Pin = z.infer<typeof LocalVersionPinSchema>;
type Inspection = ReturnType<LocalPolicyService["authoring"]>;

function publicRelease(release: PolicyRelease) {
  return LocalPolicyReleaseViewSchema.parse(release);
}

function applicable(release: PolicyRelease) {
  return {
    releaseId: release.id,
    revision: release.revision,
    releaseHash: release.releaseHash,
    lifecycle: release.lifecycle,
    target: release.target,
  };
}

function ruleDiff(before: PolicyRelease | null, after: PolicyRelease) {
  const left = new Map((before?.definition.rules ?? []).map((rule) => [rule.rule_id,rule]));
  const right = new Map(after.definition.rules.map((rule) => [rule.rule_id,rule]));
  return [...new Set([...left.keys(),...right.keys()])].sort().flatMap((ruleId) => {
    const prior = left.get(ruleId) ?? null, next = right.get(ruleId) ?? null;
    if (prior && next && canonical(prior) === canonical(next)) return [];
    return [{ change: !prior ? "added" as const : !next ? "removed" as const : "changed" as const,
      ruleId, before: prior, after: next }];
  });
}

function requiresUnsupportedApproval(inspection: Inspection): boolean {
  return inspection.approvalRequired
    || inspection.applicable.some((release) => release.definition.rules.some((rule) => rule.decision === "require_approval"));
}

function itemFor(inspection: Inspection): LocalPolicyUiItem {
  const release = inspection.release;
  const readiness = release.lifecycle === "revoked"
    ? { state:"not_ready" as const,code:"release_revoked" as const,label:"Revoked",remediation:"Choose a non-revoked release or author a new immutable draft." }
    : inspection.stale
      ? { state:"stale" as const,code:"release_stale" as const,label:"Reload required",remediation:"A newer release exists. Reload Policy history before reviewing or publishing this draft." }
      : requiresUnsupportedApproval(inspection)
        ? { state:"not_ready" as const,code:"approval_unsupported" as const,label:"Not Ready",remediation:"Local approval dispatch is not available. Keep this release as a draft or replace approval-required rules with a narrower allow or deny rule." }
        : { state:"ready" as const,code:"ready" as const,label:"Ready to review",remediation:"This preview grants no authority. Live requests still require effect-time Policy admission." };
  return LocalPolicyUiItemSchema.parse({
    release: publicRelease(release),
    selection: inspection.selection ? { releaseId:inspection.selection.releaseId,sequence:inspection.selection.sequence,
      action:inspection.selection.action } : null,
    baselineRelease: inspection.baseline ? applicable(inspection.baseline) : null,
    upstreamRelease: inspection.upstreamRelease ? applicable(inspection.upstreamRelease) : null,
    upstreamScope: inspection.upstreamScope,
    effectiveScope: inspection.effectiveScope,
    applicableReleases: inspection.applicable.map(applicable),
    diff: ruleDiff(inspection.baseline,release),
    readiness,
    grantsAuthority:false,
  });
}

function unavailableItem(release: PolicyRelease): LocalPolicyUiItem {
  return LocalPolicyUiItemSchema.parse({
    release:publicRelease(release),selection:null,baselineRelease:null,upstreamRelease:null,
    upstreamScope:{},effectiveScope:{},applicableReleases:[applicable(release)],diff:ruleDiff(null,release),
    readiness:{ state:"not_ready",code:"authority_unavailable",label:"Not Ready",remediation:"Reload after the Local host can prove the direct grant, Connector, and upstream Policy ceiling." },
    grantsAuthority:false,
  });
}

function typedFailure(error: unknown): LocalPolicyUiReply {
  if (error instanceof StorageError) {
    const code = LocalPolicyUiRejectionCodeSchema.safeParse(error.code);
    if (code.success) return { ok:false,error:{ code:code.data,retryable:false } };
  }
  return localFailure("OUTCOME_UNKNOWN");
}

/** Renderer composition seam for P2. Context, role, target lineage, Tool anchors,
 * release hashes and the command owner all remain selected by the Local host. */
export class LocalPolicyUiEndpoint {
  constructor(private readonly resolve: () => LocalPolicyService | null) {}

  invoke(raw: unknown,isActive: () => boolean): LocalPolicyUiReply {
    const request = LocalPolicyUiRequestSchema.safeParse(raw);
    if (!request.success) return localFailure("INVALID_PAYLOAD");
    if (!isActive()) return localFailure("NOT_AUTHENTICATED");
    const service = this.resolve();
    if (!service) return localFailure("SERVICE_UNAVAILABLE");
    const assertExpected = (expected: Pin) => {
      if (canonical(expected) !== canonical(service.authority().expected)) throw new StorageError("REVISION_CONFLICT");
    };
    const workspace = () => {
      const releases = service.list();
      const items = releases.map((release) => {
        try { return itemFor(service.authoring({ id:release.id })); }
        catch { return unavailableItem(release); }
      });
      const layers = [...new Set(["organization" as const,...releases.map((release) => release.target.layer)])];
      return LocalPolicyUiWorkspaceSchema.parse({
        schemaVersion:"orchestrion.local.policy.ui.v1",
        projectId:service.context.project_id,
        expected:service.authority().expected,
        supportedLayers:layers,
        items,
      });
    };
    const success = (selectedReleaseId: string | null,simulation: LocalPolicySimulationView | null = null): LocalPolicyUiReply => ({
      ok:true,value:LocalPolicyUiValueSchema.parse({ workspace:workspace(),selectedReleaseId,simulation }),
    });
    const header = (expected: Pin,requestId: string,idempotencyKey: string) => ({
      ...service.authority(),expected,schema_version:LOCAL_CONTRACT_VERSION,request_id:requestId,idempotency_key:idempotencyKey,run:null,
    });
    const requireReady = (inspection: Inspection) => {
      if (inspection.stale) throw new StorageError("POLICY_RELEASE_STALE");
      if (inspection.release.lifecycle === "revoked") throw new StorageError("POLICY_REVOKED");
      if (requiresUnsupportedApproval(inspection)) throw new StorageError("POLICY_APPROVAL_RUNTIME_UNSUPPORTED");
    };

    try {
      if (request.data.operation === "snapshot") return success(null);
      assertExpected(request.data.expected);
      if (request.data.operation === "draft") {
        const source = service.authoring({ id:request.data.payload.source.id });
        const pin = request.data.payload.source;
        if (source.release.releaseHash !== pin.releaseHash) throw new StorageError("POLICY_HASH_CONFLICT");
        if (source.release.stateRevision !== pin.stateRevision) throw new StorageError("POLICY_STATE_CONFLICT");
        if (source.release.lifecycle === "revoked") throw new StorageError("POLICY_REVOKED");
        const result = service.createDraft(header(request.data.expected,request.data.requestId,request.data.idempotencyKey),{
          target:source.release.target,
          toolName:source.release.toolName,
          definition:{ ...source.release.definition,rules:request.data.payload.rules },
        });
        return success(result.resultRef);
      }
      if (request.data.operation === "transition") {
        const inspection = service.authoring({ id:request.data.payload.id });
        requireReady(inspection);
        const result = service.transition(header(request.data.expected,request.data.requestId,request.data.idempotencyKey),request.data.payload);
        return success(result.resultRef);
      }
      if (request.data.operation === "select") {
        const inspection = service.authoring({ id:request.data.payload.id });
        requireReady(inspection);
        service.select(header(request.data.expected,request.data.requestId,request.data.idempotencyKey),request.data.payload);
        return success(request.data.payload.id);
      }

      const pin = request.data.payload;
      const inspection = service.authoring({ id:pin.id });
      if (inspection.release.releaseHash !== pin.releaseHash || inspection.release.stateRevision !== pin.stateRevision || inspection.stale) {
        const simulation = LocalPolicyUiValueSchema.shape.simulation.unwrap().parse({
          schemaVersion:"orchestrion.local.policy.simulation.v1",state:"stale",canonicalResource:null,decision:null,matchedRules:[],
          diagnostics:[{ code:"POLICY_RELEASE_STALE",message:"Policy evidence changed.",correctiveAction:"Reload Policy history before simulating again." }],
          grantsAuthority:false,dispatchCount:0,
        });
        return success(pin.id,simulation);
      }
      const resource = pin.resource;
      if (!exactPath(resource.value)) {
        const simulation = LocalPolicyUiValueSchema.shape.simulation.unwrap().parse({
          schemaVersion:"orchestrion.local.policy.simulation.v1",state:"not_ready",canonicalResource:null,decision:null,matchedRules:[],
          diagnostics:[{ code:"TOOL_POLICY_INPUT_INVALID",message:"The resource is not a canonical Local path.",correctiveAction:"Use an absolute path with normalized segments and no wildcard, traversal, or encoded separator." }],
          grantsAuthority:false,dispatchCount:0,
        });
        return success(pin.id,simulation);
      }
      const result = service.simulate({ id:pin.id,releaseHash:pin.releaseHash,stateRevision:pin.stateRevision,
        claims:[{ type:resource.resourceType,value:resource.value,mode:resource.mode }] });
      const matchedRules = inspection.applicable.flatMap((release) => release.definition.rules.filter((rule) =>
        rule.resource_type === resource.resourceType && rule.mode === resource.mode
        && (resource.value === rule.matcher.value || (rule.matcher.kind === "path_prefix" && resource.value.startsWith(`${rule.matcher.value}/`))))
        .map((rule) => ({ releaseId:release.id,ruleId:rule.rule_id })));
      const unsupported = result.decision.outcome === "require_approval";
      const simulation = LocalPolicyUiValueSchema.shape.simulation.unwrap().parse({
        schemaVersion:"orchestrion.local.policy.simulation.v1",
        state:unsupported ? "not_ready" : result.decision.outcome === "allow" ? "allowed" : "denied",
        canonicalResource:resource,
        decision:{ outcome:result.decision.outcome,restrictionOrder:result.decision.restriction_order,
          reasonCodes:result.decision.reason_codes,effectiveScope:result.decision.effective_scope },
        matchedRules,
        diagnostics:unsupported ? [{ code:"POLICY_APPROVAL_RUNTIME_UNSUPPORTED",message:"This fixture requires approval, which Local cannot dispatch yet.",
          correctiveAction:"Keep the release unpublished or use a deny rule until the approval runtime is available." }] : [],
        grantsAuthority:false,dispatchCount:0,
      });
      return success(pin.id,simulation);
    } catch (error) { return typedFailure(error); }
  }
}
