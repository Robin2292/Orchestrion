import {
  AgentDefinitionSchema,
  type AgentDefinition,
} from "../shared/agent-contracts";

export type AgentPreset = AgentDefinition["nodeType"];

export interface LocalAgentFormState {
  nodeType: AgentPreset;
  name: string;
  description: string;
  userGuide: string;
  role: string;
  providerType: string;
  modelId: string;
  systemPrompt: string;
  userPromptTemplate: string;
  inputSchema: string;
  outputSchema: string;
  modelParams: string;
  outputType: string;
  maxTokens: string;
  maxRetries: string;
  maxToolTurns: string;
  timeoutSeconds: string;
  codeTimeoutSeconds: string;
  codingTimeoutSeconds: string;
  toolTurnLimitMode: "soft" | "hard";
  maxToolBudget: string;
  planMode: "execute_only" | "plan_then_execute" | "plan_await_approval" | "plan_only";
  interactionMode: "autonomous" | "conversational" | "approval_gated";
  carryConversation: boolean;
  finalizationPrompt: string;
  jsonExtractionPrompt: string;
  fallbackModels: string;
  terminalPrompt: string;
  terminalMode: "" | "interactive" | "headless";
  codeScript: string;
  codingProvider: string;
  codingPrompt: string;
  codingModel: string;
  codingMaxTurns: string;
  codingAllowedTools: string;
  codingPermissionMode: "" | "default" | "accept_edits" | "full_auto";
  workflowId: string;
  workflowVersionId: string;
  workflowAutoUpgrade: boolean;
}

export const AGENT_PRESET_LABELS: Record<AgentPreset, string> = {
  agent: "LLM Agent",
  terminal: "Terminal template",
  code: "Code template",
  coding_agent: "Coding Agent template",
  sub_workflow: "Workflow-backed Agent",
};

export const AGENT_PRESET_READINESS: Record<AgentPreset, { tone: "definition" | "separate"; label: string; detail: string }> = {
  agent: { tone: "definition", label: "Definition ready", detail: "A published version can supply its instructions and governed tool bindings to a Codex Session. Workflow execution and provider/model configuration remain separate." },
  terminal: { tone: "separate", label: "Stored template only", detail: "Interactive Terminal is a separate human-controlled surface. This preset is not executable from Local Agents." },
  code: { tone: "separate", label: "Stored template only", detail: "Code execution is not available from this editor in A1." },
  coding_agent: { tone: "separate", label: "Stored template", detail: "A published version can supply its prompt and governed tool bindings to a Codex Session. Session model settings and native Codex tools remain separate." },
  sub_workflow: { tone: "separate", label: "Stored reference only", detail: "The Workflow reference grants no execution authority and is not runnable in A1." },
};

function formatted(value: unknown): string {
  return value == null ? "" : JSON.stringify(value, null, 2);
}

function baseDefinition(nodeType: AgentPreset): AgentDefinition {
  return AgentDefinitionSchema.parse({
    nodeType,
    config: nodeType === "agent" ? null
      : nodeType === "terminal" ? { node_type: "terminal", initial_prompt: "", execution_mode: "interactive" }
      : nodeType === "code" ? { node_type: "code", script: "return input;", timeout_seconds: 60, input_schema: null, output_schema: null }
      : nodeType === "coding_agent" ? { node_type: "coding_agent", provider: "codex", prompt: "", model: null, timeout_seconds: 3600, max_turns: 20, allowed_tools: null, permission_mode: "default" }
      : { node_type: "sub_workflow", workflow_id: "workflow-id", workflow_version_id: "workflow-version-id", auto_upgrade: false, input_schema: null },
    role: null,
    systemPrompt: null,
    userPromptTemplate: null,
    providerType: nodeType === "agent" ? "openai" : "",
    modelId: nodeType === "agent" ? "gpt-4o" : "",
    modelParams: nodeType === "agent" ? { temperature: 0.7 } : null,
    inputSchema: null,
    outputSchema: null,
    outputType: "json",
    toolGrants: { schema_version: "tool_grants@1", grants: [] },
    maxTokens: null,
    maxRetries: 2,
    maxToolTurns: null,
    timeoutSeconds: null,
    toolTurnLimitMode: "soft",
    maxToolBudget: null,
    planMode: "execute_only",
    interactionMode: "autonomous",
    carryConversation: false,
    finalizationPrompt: null,
    jsonExtractionPrompt: null,
    fallbackModels: null,
  });
}

export function initialLocalAgentForm(nodeType: AgentPreset = "agent", definition?: AgentDefinition, metadata?: {
  name: string; description: string | null; userGuide: string | null;
}): LocalAgentFormState {
  const source = definition ?? baseDefinition(nodeType);
  const config = source.config ?? {};
  return {
    nodeType: source.nodeType,
    name: metadata?.name ?? "",
    description: metadata?.description ?? "",
    userGuide: metadata?.userGuide ?? "",
    role: source.role ?? "",
    providerType: source.providerType,
    modelId: source.modelId,
    systemPrompt: source.systemPrompt ?? "",
    userPromptTemplate: source.userPromptTemplate ?? "",
    inputSchema: formatted(source.inputSchema),
    outputSchema: formatted(source.outputSchema),
    modelParams: formatted(source.modelParams),
    outputType: source.outputType,
    maxTokens: source.maxTokens == null ? "" : String(source.maxTokens),
    maxRetries: String(source.maxRetries),
    maxToolTurns: source.maxToolTurns == null ? "" : String(source.maxToolTurns),
    timeoutSeconds: source.timeoutSeconds == null ? "" : String(source.timeoutSeconds),
    codeTimeoutSeconds: source.nodeType === "code" && typeof config.timeout_seconds === "number"
      ? String(config.timeout_seconds) : definition ? "" : "60",
    codingTimeoutSeconds: source.nodeType === "coding_agent" && typeof config.timeout_seconds === "number"
      ? String(config.timeout_seconds) : definition ? "" : "3600",
    toolTurnLimitMode: source.toolTurnLimitMode,
    maxToolBudget: source.maxToolBudget == null ? "" : String(source.maxToolBudget),
    planMode: source.planMode ?? "execute_only",
    interactionMode: source.interactionMode ?? "autonomous",
    carryConversation: source.carryConversation ?? false,
    finalizationPrompt: source.finalizationPrompt ?? "",
    jsonExtractionPrompt: source.jsonExtractionPrompt ?? "",
    fallbackModels: formatted(source.fallbackModels),
    terminalPrompt: typeof config.initial_prompt === "string" ? config.initial_prompt : "",
    terminalMode: config.execution_mode === "headless" || config.execution_mode === "interactive"
      ? config.execution_mode : definition ? "" : "interactive",
    codeScript: typeof config.script === "string" ? config.script : "return input;",
    codingProvider: typeof config.provider === "string" ? config.provider : "codex",
    codingPrompt: typeof config.prompt === "string" ? config.prompt : "",
    codingModel: typeof config.model === "string" ? config.model : "",
    codingMaxTurns: typeof config.max_turns === "number" ? String(config.max_turns) : definition ? "" : "20",
    codingAllowedTools: Array.isArray(config.allowed_tools) ? config.allowed_tools.join("\n") : "",
    codingPermissionMode: config.permission_mode === "default" || config.permission_mode === "accept_edits" || config.permission_mode === "full_auto"
      ? config.permission_mode : definition ? "" : "default",
    workflowId: typeof config.workflow_id === "string" && (definition !== undefined || config.workflow_id !== "workflow-id")
      ? config.workflow_id : "",
    workflowVersionId: typeof config.workflow_version_id === "string" && (definition !== undefined || config.workflow_version_id !== "workflow-version-id")
      ? config.workflow_version_id : "",
    workflowAutoUpgrade: config.auto_upgrade === true,
  };
}

function objectField(value: string, field: string, errors: Record<string, string>): Record<string, unknown> | null {
  if (!value.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    errors[field] = "Enter a JSON object, such as { \"type\": \"object\" }.";
    return null;
  }
}

function optionalInteger(value: string, field: string, errors: Record<string, string>, minimum = 1): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    errors[field] = `Enter a whole number of ${minimum} or more.`;
    return null;
  }
  return parsed;
}

export function buildAgentDefinition(form: LocalAgentFormState, previous?: AgentDefinition): {
  definition: AgentDefinition | null;
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};
  const inputSchema = objectField(form.inputSchema, "inputSchema", errors);
  const outputSchema = objectField(form.outputSchema, "outputSchema", errors);
  const modelParams = objectField(form.modelParams, "modelParams", errors);
  const timeoutSeconds = optionalInteger(form.timeoutSeconds, "timeoutSeconds", errors);
  const codeTimeoutSeconds = optionalInteger(form.codeTimeoutSeconds, "codeTimeoutSeconds", errors);
  const codingTimeoutSeconds = optionalInteger(form.codingTimeoutSeconds, "codingTimeoutSeconds", errors, 30);
  const maxTokens = optionalInteger(form.maxTokens, "maxTokens", errors);
  const maxToolTurns = optionalInteger(form.maxToolTurns, "maxToolTurns", errors);
  const maxRetries = optionalInteger(form.maxRetries, "maxRetries", errors, 0);
  if (!form.name.trim()) errors.name = "Name is required.";

  let config: Record<string, unknown> | null = null;
  const priorConfig = previous?.nodeType === form.nodeType ? previous.config : baseDefinition(form.nodeType).config;
  const priorForm = previous ? initialLocalAgentForm(form.nodeType, previous) : null;
  if (form.nodeType === "terminal") {
    config = { ...(priorConfig ?? {}), node_type: "terminal", initial_prompt: form.terminalPrompt };
    if (!previous || form.terminalMode !== priorForm?.terminalMode) {
      if (form.terminalMode) config.execution_mode = form.terminalMode;
      else delete config.execution_mode;
    }
  }
  if (form.nodeType === "code") {
    if (!form.codeScript.trim()) errors.codeScript = "Script is required.";
    config = { ...(priorConfig ?? {}), node_type: "code", script: form.codeScript };
    if (!previous || form.codeTimeoutSeconds !== priorForm?.codeTimeoutSeconds) {
      if (codeTimeoutSeconds == null) delete config.timeout_seconds;
      else config.timeout_seconds = codeTimeoutSeconds;
    }
  }
  if (form.nodeType === "coding_agent") {
    if (!form.codingProvider.trim()) errors.codingProvider = "Provider is required.";
    config = { ...(priorConfig ?? {}), node_type: "coding_agent", provider: form.codingProvider.trim(), prompt: form.codingPrompt };
    if (!previous || form.codingModel !== priorForm?.codingModel) config.model = form.codingModel.trim() || null;
    if (!previous || form.codingTimeoutSeconds !== priorForm?.codingTimeoutSeconds) {
      if (codingTimeoutSeconds == null) delete config.timeout_seconds;
      else config.timeout_seconds = codingTimeoutSeconds;
    }
    if (!previous || form.codingMaxTurns !== priorForm?.codingMaxTurns)
      config.max_turns = optionalInteger(form.codingMaxTurns, "codingMaxTurns", errors);
    if (!previous || form.codingAllowedTools !== priorForm?.codingAllowedTools)
      config.allowed_tools = form.codingAllowedTools.trim() ? form.codingAllowedTools.split("\n").map((value) => value.trim()).filter(Boolean) : null;
    if (!previous || form.codingPermissionMode !== priorForm?.codingPermissionMode) {
      if (form.codingPermissionMode) config.permission_mode = form.codingPermissionMode;
      else delete config.permission_mode;
    }
  }
  if (form.nodeType === "sub_workflow") {
    if (!form.workflowId.trim()) errors.workflowId = "Workflow ID is required.";
    if (!form.workflowVersionId.trim()) errors.workflowVersionId = "Workflow version ID is required.";
    config = { ...(priorConfig ?? {}), node_type: "sub_workflow", workflow_id: form.workflowId.trim(),
      workflow_version_id: form.workflowVersionId.trim() };
    // Every newly published workflow-backed Agent version is exact-version
    // pinned. An immutable legacy version may retain true, but it is never
    // propagated into the new definition.
    config.auto_upgrade = false;
  }

  const seed = previous ?? baseDefinition(form.nodeType);
  const candidate = {
    ...seed,
    nodeType: form.nodeType,
    config,
    role: form.role.trim() || null,
    systemPrompt: form.nodeType === "agent" ? form.systemPrompt || null : seed.systemPrompt,
    userPromptTemplate: form.nodeType === "agent" ? form.userPromptTemplate || null : seed.userPromptTemplate,
    providerType: form.nodeType === "agent" ? form.providerType.trim() : seed.providerType,
    modelId: form.nodeType === "agent" ? form.modelId.trim() : seed.modelId,
    modelParams: form.nodeType === "agent" ? modelParams : seed.modelParams,
    inputSchema,
    outputSchema,
    outputType: form.outputType.trim() || "json",
    maxTokens: form.nodeType === "agent" ? maxTokens : seed.maxTokens,
    maxRetries: form.nodeType === "agent" ? maxRetries ?? 0 : seed.maxRetries,
    maxToolTurns: form.nodeType === "agent" ? maxToolTurns : seed.maxToolTurns,
    ...(form.nodeType === "agent" && (form.timeoutSeconds.trim() || seed.timeoutSeconds !== undefined)
      ? { timeoutSeconds } : {}),
  };
  if (form.nodeType === "agent") {
    if (!form.providerType.trim()) errors.providerType = "Provider is required.";
    if (!form.modelId.trim()) errors.modelId = "Model is required.";
  }
  if (Object.keys(errors).length) return { definition: null, errors };
  const parsed = AgentDefinitionSchema.safeParse(candidate);
  if (!parsed.success) return { definition: null, errors: { form: "This preset does not match the current Local Agent schema. Review its required fields." } };
  return { definition: parsed.data, errors };
}
