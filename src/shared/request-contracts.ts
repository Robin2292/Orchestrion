import type {
  ApprovalDecision,
  McpElicitationMode,
  PendingRequest,
  UserInputQuestion,
} from "./contracts";

export const LEGACY_APPROVAL_DECISIONS: readonly ApprovalDecision[] = [
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
];

export type UserInputSelection =
  | { kind: "option"; value: string }
  | { kind: "other"; value: string }
  | { kind: "text"; value: string };

export interface ElicitationFormField {
  name: string;
  label: string;
  description?: string;
  kind: "string" | "enum" | "number" | "integer" | "boolean";
  required: boolean;
  options?: string[];
  defaultValue?: string | number | boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  format?: "email" | "uri" | "date" | "date-time";
}

export type ElicitationFormDefinition =
  | { supported: true; fields: ElicitationFormField[] }
  | { supported: false; reason: string };

export type ElicitationFormValues = Record<string, string | boolean>;

export function effectiveApprovalDecisions(request: Pick<PendingRequest, "availableDecisions">): readonly ApprovalDecision[] {
  return request.availableDecisions === undefined ? LEGACY_APPROVAL_DECISIONS : request.availableDecisions;
}

export function approvalDecisionKey(decision: ApprovalDecision): string {
  return typeof decision === "string" ? decision : JSON.stringify(decision);
}

export function approvalDecisionAllowed(request: Pick<PendingRequest, "availableDecisions">, decision: ApprovalDecision): boolean {
  return effectiveApprovalDecisions(request).some((candidate) => sameApprovalDecision(candidate, decision));
}

export function buildUserInputAnswers(
  questions: UserInputQuestion[],
  selections: Record<string, UserInputSelection | undefined>,
): Record<string, { answers: string[] }> {
  return Object.fromEntries(questions.flatMap((question) => {
    const selection = selections[question.id];
    return selection ? [[question.id, { answers: [selection.value] }] as const] : [];
  }));
}

export function userInputAnswersComplete(
  questions: UserInputQuestion[],
  selections: Record<string, UserInputSelection | undefined>,
): boolean {
  return questions.length > 0 && questions.every((question) => {
    const selection = selections[question.id];
    if (!selection || !selection.value.trim()) return false;
    if (selection.kind === "other") return question.isOther === true;
    if (selection.kind === "option") return question.options?.some((option) => option.label === selection.value) === true;
    return !question.options?.length;
  });
}

export function parseElicitationFormSchema(schema: unknown, mode: McpElicitationMode): ElicitationFormDefinition {
  if (mode === "url") return { supported: false, reason: "URL confirmations are not forms." };
  if (!isObject(schema) || schema.type !== "object" || !isObject(schema.properties)) {
    return { supported: false, reason: "This request does not contain a supported object schema." };
  }
  if (Object.keys(schema).some((key) => !["$schema", "type", "properties", "required"].includes(key))) {
    return { supported: false, reason: "The form uses unsupported object-schema features." };
  }
  if (schema.$schema !== undefined && typeof schema.$schema !== "string") {
    return { supported: false, reason: "The form has an invalid schema identifier." };
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((value) => typeof value !== "string"))) {
    return { supported: false, reason: "The form has an invalid required-fields list." };
  }
  const properties = schema.properties;
  const required = new Set(schema.required as string[] | undefined);
  const fields: ElicitationFormField[] = [];
  for (const [name, rawProperty] of Object.entries(properties)) {
    const field = parseElicitationField(name, rawProperty, required.has(name));
    if (typeof field === "string") return { supported: false, reason: field };
    fields.push(field);
  }
  if ([...required].some((name) => !(name in properties))) {
    return { supported: false, reason: "The form requires a field that is not defined in its properties." };
  }
  return { supported: true, fields };
}

export function initialElicitationFormValues(form: Extract<ElicitationFormDefinition, { supported: true }>): ElicitationFormValues {
  return Object.fromEntries(form.fields.map((field) => {
    if (field.kind === "boolean") return [field.name, field.defaultValue === true];
    if (field.defaultValue !== undefined) return [field.name, String(field.defaultValue)];
    return [field.name, ""];
  }));
}

export function buildElicitationContent(
  form: Extract<ElicitationFormDefinition, { supported: true }>,
  values: ElicitationFormValues,
): { ok: true; content: Record<string, string | number | boolean> } | { ok: false; error: string } {
  const content: Record<string, string | number | boolean> = {};
  for (const field of form.fields) {
    const raw = values[field.name];
    if (field.kind === "boolean") {
      if (raw === undefined && !field.required) continue;
      if (typeof raw !== "boolean") return { ok: false, error: `${field.label} must be true or false.` };
      content[field.name] = raw;
      continue;
    }
    if (raw === undefined && !field.required) continue;
    if (typeof raw !== "string") return { ok: false, error: `${field.label} is invalid.` };
    if (raw === "" && !field.required) continue;
    if (field.kind === "enum") {
      if (!field.options?.includes(raw)) return { ok: false, error: `${field.label} must be one of the offered choices.` };
      content[field.name] = raw;
      continue;
    }
    if (field.kind === "string") {
      if (field.minLength !== undefined && raw.length < field.minLength) return { ok: false, error: `${field.label} is too short.` };
      if (field.maxLength !== undefined && raw.length > field.maxLength) return { ok: false, error: `${field.label} is too long.` };
      if (field.format && !validStringFormat(raw, field.format)) return { ok: false, error: `${field.label} is not a valid ${field.format}.` };
      content[field.name] = raw;
      continue;
    }
    if (raw.trim() === "") return { ok: false, error: `${field.label} is required.` };
    const number = Number(raw);
    if (!Number.isFinite(number) || (field.kind === "integer" && (!Number.isInteger(number) || !Number.isSafeInteger(number)))) {
      return { ok: false, error: `${field.label} must be ${field.kind === "integer" ? "an integer" : "a number"}.` };
    }
    if (field.minimum !== undefined && number < field.minimum) return { ok: false, error: `${field.label} is below the minimum.` };
    if (field.maximum !== undefined && number > field.maximum) return { ok: false, error: `${field.label} is above the maximum.` };
    content[field.name] = number;
  }
  return { ok: true, content };
}

export function validateElicitationContent(
  request: Pick<PendingRequest, "elicitation">,
  content: Record<string, unknown> | null,
): boolean {
  const elicitation = request.elicitation;
  if (!elicitation) return false;
  if (elicitation.mode === "url") return content === null;
  if (!isObject(content)) return false;
  const form = parseElicitationFormSchema(elicitation.requestedSchema, elicitation.mode);
  if (!form.supported) return false;
  const values: ElicitationFormValues = {};
  for (const field of form.fields) {
    const value = content[field.name];
    if (typeof value === "boolean") values[field.name] = value;
    else if (typeof value === "string" || typeof value === "number") values[field.name] = String(value);
    else if (value !== undefined) return false;
  }
  const built = buildElicitationContent(form, values);
  if (!built.ok) return false;
  return sameRecord(built.content, content);
}

function parseElicitationField(name: string, value: unknown, required: boolean): ElicitationFormField | string {
  if (!isObject(value) || typeof value.type !== "string") return `Field ${name} has an unsupported schema.`;
  const label = typeof value.title === "string" && value.title ? value.title : name;
  const description = typeof value.description === "string" ? value.description : undefined;
  if (value.type === "string") {
    if (Object.keys(value).some((key) => !["type", "title", "description", "enum", "default", "minLength", "maxLength", "format"].includes(key))) return `Field ${label} uses unsupported schema features.`;
    if (value.enum !== undefined) {
      if (!Array.isArray(value.enum) || value.enum.length === 0 || value.enum.some((option) => typeof option !== "string")) return `Field ${label} has an unsupported enum.`;
      if (value.default !== undefined && (typeof value.default !== "string" || !value.enum.includes(value.default))) return `Field ${label} has an invalid default.`;
      return { name, label, description, kind: "enum", required, options: value.enum as string[], defaultValue: value.default as string | undefined };
    }
    if (value.default !== undefined && typeof value.default !== "string") return `Field ${label} has an invalid default.`;
    if (!optionalNonNegativeInteger(value.minLength) || !optionalNonNegativeInteger(value.maxLength)) return `Field ${label} has invalid length limits.`;
    if (typeof value.minLength === "number" && typeof value.maxLength === "number" && value.minLength > value.maxLength) return `Field ${label} has inconsistent length limits.`;
    const format = value.format;
    if (format !== undefined && !["email", "uri", "date", "date-time"].includes(String(format))) return `Field ${label} has an unsupported format.`;
    if (typeof value.default === "string") {
      if (typeof value.minLength === "number" && value.default.length < value.minLength) return `Field ${label} has an invalid default.`;
      if (typeof value.maxLength === "number" && value.default.length > value.maxLength) return `Field ${label} has an invalid default.`;
      if (format && !validStringFormat(value.default, format as NonNullable<ElicitationFormField["format"]>)) return `Field ${label} has an invalid default.`;
    }
    return { name, label, description, kind: "string", required, defaultValue: value.default as string | undefined, minLength: value.minLength as number | undefined, maxLength: value.maxLength as number | undefined, format: format as ElicitationFormField["format"] };
  }
  if (value.type === "number" || value.type === "integer") {
    if (Object.keys(value).some((key) => !["type", "title", "description", "minimum", "maximum", "default"].includes(key))) return `Field ${label} uses unsupported schema features.`;
    if (!optionalNumber(value.minimum) || !optionalNumber(value.maximum) || !optionalNumber(value.default)) return `Field ${label} has invalid numeric constraints.`;
    if (typeof value.minimum === "number" && typeof value.maximum === "number" && value.minimum > value.maximum) return `Field ${label} has inconsistent numeric constraints.`;
    if (value.type === "integer" && value.default !== undefined && !Number.isInteger(value.default)) return `Field ${label} has a non-integer default.`;
    if (value.type === "integer" && [value.minimum, value.maximum, value.default].some((candidate) => candidate !== undefined && !Number.isSafeInteger(candidate))) return `Field ${label} exceeds the supported safe integer range.`;
    if (typeof value.default === "number" && ((typeof value.minimum === "number" && value.default < value.minimum) || (typeof value.maximum === "number" && value.default > value.maximum))) return `Field ${label} has an invalid default.`;
    return { name, label, description, kind: value.type, required, defaultValue: value.default as number | undefined, minimum: value.minimum as number | undefined, maximum: value.maximum as number | undefined };
  }
  if (value.type === "boolean") {
    if (Object.keys(value).some((key) => !["type", "title", "description", "default"].includes(key))) return `Field ${label} uses unsupported schema features.`;
    if (value.default !== undefined && typeof value.default !== "boolean") return `Field ${label} has an invalid default.`;
    return { name, label, description, kind: "boolean", required, defaultValue: value.default as boolean | undefined };
  }
  return `Field ${label} uses unsupported type ${value.type}.`;
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function optionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

function sameApprovalDecision(left: ApprovalDecision, right: ApprovalDecision): boolean {
  if (typeof left === "string" || typeof right === "string") return left === right;
  if ("acceptWithExecpolicyAmendment" in left && "acceptWithExecpolicyAmendment" in right) {
    const leftTokens = left.acceptWithExecpolicyAmendment.execpolicy_amendment;
    const rightTokens = right.acceptWithExecpolicyAmendment.execpolicy_amendment;
    return leftTokens.length === rightTokens.length && leftTokens.every((token, index) => token === rightTokens[index]);
  }
  if ("applyNetworkPolicyAmendment" in left && "applyNetworkPolicyAmendment" in right) {
    const leftRule = left.applyNetworkPolicyAmendment.network_policy_amendment;
    const rightRule = right.applyNetworkPolicyAmendment.network_policy_amendment;
    return leftRule.host === rightRule.host && leftRule.action === rightRule.action;
  }
  return false;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validStringFormat(value: string, format: NonNullable<ElicitationFormField["format"]>): boolean {
  if (format === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (format === "uri") {
    try { new URL(value); return true; } catch { return false; }
  }
  if (format === "date") return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
  return !Number.isNaN(Date.parse(value));
}

function sameRecord(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}
