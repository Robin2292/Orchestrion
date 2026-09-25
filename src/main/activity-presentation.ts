import type {
  ConversationActivity,
  ConversationActivityStatus,
} from "../shared/contracts";

type JsonObject = Record<string, unknown>;

const DISPLAY_LIMIT = 24_000;
const SECRET_KEY = /(?:authorization|cookie|credential|password|private[_-]?key|secret|session[_-]?token|access[_-]?token|refresh[_-]?token|api[_-]?key)/i;
const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
const SECRET_ASSIGNMENT = /\b(password|secret|token|api[_-]?key)\s*[:=]\s*([^\s,;]+)/gi;

export function activityFromItem(item: JsonObject, completed: boolean): ConversationActivity | null {
  const type = stringValue(item.type);
  const status = activityStatus(item, completed);
  const durationMs = finiteNumber(item.durationMs);

  if (type === "reasoning") {
    return compact({
      kind: "reasoning",
      label: "Reasoning summary",
      status,
      summary: completed ? "Reasoning summary prepared" : "Working through the next step",
      // `content` is intentionally ignored. It may contain private chain-of-thought.
      result: publicReasoningSummary(item.summary),
      durationMs,
    });
  }

  if (type === "commandExecution") {
    const command = safeDisplay(item.command);
    const cwd = stringValue(item.cwd);
    const exitCode = finiteNumber(item.exitCode);
    return compact({
      kind: "command",
      label: command ? `Ran ${oneLine(command, 88)}` : "Ran command",
      status,
      summary: exitCode === undefined ? undefined : `Exited with code ${exitCode}`,
      arguments: command,
      result: safeDisplay(item.aggregatedOutput),
      metadata: cwd ? [{ label: "Directory", value: redact(cwd) }] : undefined,
      durationMs,
    });
  }

  if (type === "mcpToolCall") {
    const server = stringValue(item.server);
    const tool = stringValue(item.tool) || "tool";
    return compact({
      kind: "tool",
      label: server ? `${server} / ${tool}` : tool,
      status,
      summary: completed ? "Tool call finished" : "Using tool",
      arguments: safeDisplay(item.arguments),
      result: safeDisplay(item.result),
      error: safeDisplay(item.error),
      durationMs,
    });
  }

  if (type === "dynamicToolCall") {
    const tool = stringValue(item.tool) || "Dynamic tool";
    return compact({
      kind: "tool",
      label: tool,
      status: item.success === false ? "failed" : status,
      summary: completed ? "Tool call finished" : "Using tool",
      arguments: safeDisplay(item.arguments),
      result: safeDisplay(item.contentItems),
      durationMs,
    });
  }

  if (type === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    return compact({
      kind: "file_change",
      label: changes.length === 1 ? "Updated 1 file" : changes.length ? `Updated ${changes.length} files` : "Updated files",
      status,
      summary: completed ? "Workspace changes prepared" : "Preparing workspace changes",
      arguments: safeDisplay(item.changes),
      error: safeDisplay(item.error),
      durationMs,
    });
  }

  if (type === "collabToolCall") {
    const tool = stringValue(item.tool) || "sub-agent";
    const target = stringValue(item.receiverThreadId) || stringValue(item.newThreadId);
    const agentStatus = stringValue(item.agentStatus);
    return compact({
      kind: "subagent",
      label: collabLabel(tool),
      status,
      summary: agentStatus ? `Agent ${agentStatus}` : completed ? "Delegated work updated" : "Delegating scoped work",
      arguments: safeDisplay(item.prompt),
      result: safeDisplay(item.result),
      error: safeDisplay(item.error),
      metadata: target ? [{ label: "Task", value: redact(target) }] : undefined,
      durationMs,
    });
  }

  if (type === "contextCompaction") {
    return compact({
      kind: "compaction",
      label: "Compacted context",
      status,
      summary: completed ? "Prepared a smaller working context" : "Folding earlier context into a durable summary",
      durationMs,
    });
  }

  if (type === "webSearch") {
    const query = stringValue(item.query) || stringValue(object(item.action).query);
    return compact({
      kind: "web_search",
      label: query ? `Searched for ${oneLine(query, 88)}` : "Searched the web",
      status,
      arguments: safeDisplay(item.action ?? item.query),
      result: safeDisplay(item.result),
      error: safeDisplay(item.error),
      durationMs,
    });
  }

  if (type === "imageView") {
    return compact({
      kind: "image_view",
      label: "Viewed an image",
      status,
      arguments: safeDisplay(item.path),
      error: safeDisplay(item.error),
      durationMs,
    });
  }

  return null;
}

export function activityText(activity: ConversationActivity): string {
  const suffix = activity.status === "running" ? "" : ` · ${activity.status}`;
  return `${activity.label}${suffix}`;
}

export function appendActivityOutput(activity: ConversationActivity, delta: unknown): ConversationActivity {
  const next = bounded(`${activity.result ?? ""}${redact(String(delta ?? ""))}`);
  return { ...activity, result: next || undefined };
}

export function appendReasoningSummary(activity: ConversationActivity, delta: unknown): ConversationActivity {
  if (activity.kind !== "reasoning") return activity;
  const next = bounded(`${activity.result ?? ""}${redact(String(delta ?? ""))}`);
  return { ...activity, result: next || undefined };
}

export function safeDisplay(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return bounded(redact(value)) || undefined;
  const sanitized = sanitize(value, new WeakSet<object>());
  if (sanitized === undefined) return undefined;
  try {
    return bounded(redact(JSON.stringify(sanitized, null, 2))) || undefined;
  } catch {
    return "[unavailable]";
  }
}

function publicReasoningSummary(value: unknown): string | undefined {
  if (typeof value === "string") return safeDisplay(value);
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((part): string[] => {
    if (typeof part === "string") return [part];
    const text = stringValue(object(part).text);
    return text ? [text] : [];
  });
  return safeDisplay(parts.join("\n"));
}

function sanitize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return redact(value);
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, seen));
  return Object.fromEntries(Object.entries(value as JsonObject).map(([key, entry]) => [
    key,
    SECRET_KEY.test(key) ? "[redacted]" : sanitize(entry, seen),
  ]));
}

function redact(value: string): string {
  const withoutTokens = SECRET_VALUE_PATTERNS.reduce((current, pattern) => current.replace(pattern, "[redacted]"), value);
  return withoutTokens.replace(SECRET_ASSIGNMENT, (_match, name: string) => `${name}=[redacted]`);
}

function bounded(value: string): string {
  if (value.length <= DISPLAY_LIMIT) return value;
  return `${value.slice(0, DISPLAY_LIMIT)}\n… output truncated for display`;
}

function activityStatus(item: JsonObject, completed: boolean): ConversationActivityStatus {
  if (!completed) return "running";
  if (item.status === "failed" || item.success === false) return "failed";
  if (item.status === "declined") return "declined";
  if (item.type === "commandExecution" && finiteNumber(item.exitCode) !== undefined && finiteNumber(item.exitCode) !== 0) return "failed";
  return "completed";
}

function collabLabel(tool: string): string {
  if (tool === "spawn_agent") return "Started a sub-agent";
  if (tool === "send_message" || tool === "followup_task") return "Sent work to a sub-agent";
  if (tool === "wait") return "Waited for sub-agent work";
  if (tool === "close_agent" || tool === "interrupt_agent") return "Stopped a sub-agent";
  return `Sub-agent · ${tool}`;
}

function compact(activity: ConversationActivity): ConversationActivity {
  return Object.fromEntries(Object.entries(activity).filter(([, value]) => value !== undefined)) as unknown as ConversationActivity;
}

function oneLine(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
