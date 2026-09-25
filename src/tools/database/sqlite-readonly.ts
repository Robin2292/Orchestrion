import { randomUUID } from "node:crypto";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { z } from "zod";
import type { LocalContext } from "../../shared/local-contracts";
import { LocalContextSchema, LocalIdSchema } from "../../shared/local-contracts";
import type { ToolInvocationPlan, ToolPlannerInput } from "../../shared/tool-invocation-contracts";
import type { ToolDefinition, ToolResult } from "../../shared/tool-registry-contracts";
import type { ToolScope } from "../../shared/tool-scope";
import { normalizeFileReadPath, sensitiveContentReason } from "../builtins/file-read";
import { toolJson, type ToolImplementation } from "../registry";

export const DATABASE_CONNECTOR = "orchestrion.database.sqlite";
export const DATABASE_QUERY_TOOL = "database.query";
export const DATABASE_SCHEMA_TOOL = "database.schema";
export const DATABASE_WRITE_TOOL = "database.execute";
const IMPLEMENTATION_VERSION = "web-database-local-sqlite-readonly-v1";
export const MAX_DATABASE_BYTES = 16 * 1024 * 1024;
const MAX_SQL_BYTES = 16 * 1024;
const MAX_PARAMETER_COUNT = 64;
const MAX_PARAMETER_BYTES = 8 * 1024;
const MAX_TABLES = 64;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const RESERVED_IDENTIFIER = new Set(["__proto__", "constructor", "prototype"]);
const SENSITIVE_COLUMN = /(password|secret|token|credential|authorization|api[_-]?key)/i;

export type DatabaseAdapterCode =
  | "DATABASE_CONFIG_INVALID"
  | "DATABASE_DRIVER_UNAVAILABLE"
  | "DATABASE_NOT_APPROVED"
  | "DATABASE_ALREADY_LOADED"
  | "DATABASE_LOADER_CLOSED"
  | "DATABASE_AUTHORITY_INVALID"
  | "DATABASE_SNAPSHOT_INVALID"
  | "DATABASE_QUERY_INVALID"
  | "DATABASE_RESULT_LIMIT";

export class DatabaseAdapterError extends Error {
  constructor(readonly code: DatabaseAdapterCode) {
    super(code);
    this.name = "DatabaseAdapterError";
  }
}

const ConnectionSchema = z.object({
  context: LocalContextSchema,
  connectionId: LocalIdSchema,
  driver: z.enum(["sqlite", "postgresql", "mysql"]),
  databasePath: z.string().min(1).max(4096),
  credentialRef: z.null(),
  maxRows: z.number().int().min(1).max(1000),
  maxResultBytes: z.number().int().min(1024).max(1024 * 1024),
  allowedTables: z.array(z.string().regex(IDENTIFIER)).min(1).max(MAX_TABLES),
}).strict();
export type LocalDatabaseConnection = z.infer<typeof ConnectionSchema>;

type ReadyConnection = LocalDatabaseConnection & { driver: "sqlite"; relativePath: string; logicalPath: string };

export function databaseDriverReadiness(driver: unknown): { executionReady: boolean; reason: string | null } {
  return driver === "sqlite"
    ? { executionReady: true, reason: null }
    : { executionReady: false, reason: "DATABASE_DRIVER_UNAVAILABLE" };
}

function connection(raw: unknown, expected: LocalContext): ReadyConnection {
  try {
    const parsed = ConnectionSchema.parse(JSON.parse(toolJson(raw)));
    if (toolJson(parsed.context) !== toolJson(expected) || parsed.driver !== "sqlite") {
      throw new DatabaseAdapterError(parsed.driver === "sqlite" ? "DATABASE_CONFIG_INVALID" : "DATABASE_DRIVER_UNAVAILABLE");
    }
    if (new Set(parsed.allowedTables).size !== parsed.allowedTables.length
        || parsed.allowedTables.some((name) => name.toLowerCase().startsWith("sqlite_") || RESERVED_IDENTIFIER.has(name))
        || parsed.allowedTables.some((name, index, rows) => index > 0 && rows[index - 1] >= name)) {
      throw new DatabaseAdapterError("DATABASE_CONFIG_INVALID");
    }
    const path = normalizeFileReadPath(parsed.databasePath);
    if (!path.ok) throw new DatabaseAdapterError("DATABASE_CONFIG_INVALID");
    return { ...parsed, driver: "sqlite", relativePath: path.relative, logicalPath: path.logical };
  } catch (error) {
    if (error instanceof DatabaseAdapterError) throw error;
    throw new DatabaseAdapterError("DATABASE_CONFIG_INVALID");
  }
}

function effectiveScope(raw: ToolScope, value: ReadyConnection) {
  const parsed = z.object({
    workspace_dir: z.literal(value.logicalPath),
    connection_id: z.literal(value.connectionId),
    driver: z.literal("sqlite"),
    max_rows: z.number().int().min(1).max(value.maxRows),
    max_result_bytes: z.number().int().min(1024).max(value.maxResultBytes),
    allowed_tables: z.array(z.string().regex(IDENTIFIER)).min(1).max(value.allowedTables.length),
  }).strict().parse(raw);
  const ceiling = new Set(value.allowedTables);
  if (new Set(parsed.allowed_tables).size !== parsed.allowed_tables.length
      || parsed.allowed_tables.some((table) => !ceiling.has(table))) throw new Error("invalid table scope");
  return parsed;
}

export type QueryArguments = { connection_name: string; sql: string; parameters?: Record<string, SQLInputValue> };
export type SchemaArguments = { connection_name: string; table_name?: string };
export type DatabaseEffectiveScope = ReturnType<typeof effectiveScope>;

function normalizedParameters(raw: unknown): Record<string, SQLInputValue> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid parameters");
  const entries = Object.entries(raw);
  if (entries.length > MAX_PARAMETER_COUNT) throw new Error("invalid parameters");
  const result: Record<string, SQLInputValue> = {};
  for (const [key, item] of entries) {
    const bare = key.startsWith(":") ? key.slice(1) : key;
    if (!IDENTIFIER.test(bare) || Object.hasOwn(result, `:${bare}`)
        || !(item === null || typeof item === "string" || typeof item === "number")) throw new Error("invalid parameters");
    if (typeof item === "number" && (!Number.isFinite(item) || !Number.isSafeInteger(item))) throw new Error("invalid parameters");
    if (Buffer.byteLength(String(item ?? ""), "utf8") > MAX_PARAMETER_BYTES) throw new Error("invalid parameters");
    result[`:${bare}`] = item;
  }
  return result;
}

function normalizeQuery(input: ToolPlannerInput, value: ReadyConnection): QueryArguments {
  const args = input.arguments;
  if (args.connection_name !== value.connectionId || typeof args.sql !== "string"
      || Buffer.byteLength(args.sql, "utf8") > MAX_SQL_BYTES || /[;\0]|--|\/\*|\*\//.test(args.sql)) throw new Error("invalid query");
  const sql = args.sql.trim();
  const match = /^SELECT\s+(\*|[A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+WHERE\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*:([A-Za-z_][A-Za-z0-9_]*))?(?:\s+ORDER\s+BY\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+(ASC|DESC))?)?(?:\s+LIMIT\s+([0-9]{1,4}))?$/i.exec(sql);
  if (!match) throw new Error("invalid query");
  const scope = effectiveScope(input.scope, value);
  if (!scope.allowed_tables.includes(match[2])) throw new Error("table not allowed");
  const columns = match[1] === "*" ? [] : match[1].split(",").map((item) => item.trim());
  if (columns.length && new Set(columns).size !== columns.length) throw new Error("duplicate columns");
  const parameters = normalizedParameters(args.parameters);
  const expectedParameter = match[4] === undefined ? null : `:${match[4]}`;
  const suppliedParameters = Object.keys(parameters ?? {});
  if (expectedParameter === null ? suppliedParameters.length !== 0
    : suppliedParameters.length !== 1 || suppliedParameters[0] !== expectedParameter) throw new Error("parameter mismatch");
  if (match[7] !== undefined && Number(match[7]) > scope.max_rows) throw new Error("limit exceeds scope");
  return parameters ? { connection_name: value.connectionId, sql, parameters } : { connection_name: value.connectionId, sql };
}

function normalizeSchema(input: ToolPlannerInput, value: ReadyConnection): SchemaArguments {
  if (input.arguments.connection_name !== value.connectionId) throw new Error("connection mismatch");
  const scope = effectiveScope(input.scope, value);
  const table = input.arguments.table_name;
  if (table === undefined) return { connection_name: value.connectionId };
  if (typeof table !== "string" || !IDENTIFIER.test(table) || !scope.allowed_tables.includes(table)) throw new Error("table not allowed");
  return { connection_name: value.connectionId, table_name: table };
}

const queryParameters = {
  type: "object" as const,
  properties: {
    connection_name: { type: "string" as const, description: "Exact reviewed Local database connection identity." },
    sql: { type: "string" as const, description: "One bounded plain SELECT statement." },
    parameters: { type: "object" as const, description: "Optional named scalar parameters.", additionalProperties: true },
  },
  required: ["connection_name", "sql"], additionalProperties: false,
};
const schemaParameters = {
  type: "object" as const,
  properties: {
    connection_name: { type: "string" as const, description: "Exact reviewed Local database connection identity." },
    table_name: { type: "string" as const, description: "Optional allowlisted table name." },
  },
  required: ["connection_name"], additionalProperties: false,
};

function definition(context: LocalContext, sourceId: string, value: ReadyConnection, tool: typeof DATABASE_QUERY_TOOL | typeof DATABASE_SCHEMA_TOOL): ToolDefinition {
  return {
    context: structuredClone(context), sourceId, connectorId: DATABASE_CONNECTOR, connectionId: value.connectionId,
    name: tool,
    description: tool === DATABASE_QUERY_TOOL
      ? "Run one bounded read-only SELECT against the reviewed Local SQLite snapshot. Writes, joins, expressions, comments and multiple statements are unavailable."
      : "List allowlisted tables or inspect bounded column metadata in the reviewed Local SQLite snapshot.",
    parameters: tool === DATABASE_QUERY_TOOL ? queryParameters : schemaParameters,
    outputSchema: null,
    implementationId: `${DATABASE_CONNECTOR}.${tool}`,
    implementationVersion: IMPLEMENTATION_VERSION,
    policyMode: "external",
  };
}

export interface DatabaseAdapterRequest {
  authority: unknown;
  plan: ToolInvocationPlan;
  signal?: AbortSignal;
}
export interface DatabaseExecutionRequest {
  authority: unknown;
  relativePath: string;
  tool: typeof DATABASE_QUERY_TOOL | typeof DATABASE_SCHEMA_TOOL;
  arguments: QueryArguments | SchemaArguments;
  scope: DatabaseEffectiveScope;
  signal?: AbortSignal;
}
export type LocalDatabaseExecutor = (request: DatabaseExecutionRequest) => Promise<ToolResult>;

export function databaseFailure(code: DatabaseAdapterCode): ToolResult {
  return { success: false, data: null, error: code, summary: null, outcome: "failure", errorCode: code,
    errorCategory: "invalid_request", retryMode: "model_must_change_args" };
}
function success(data: unknown, summary: string): ToolResult {
  return { success: true, data, error: null, summary, outcome: "success", errorCode: null, errorCategory: null, retryMode: "never" };
}
function boundedSuccess(data: unknown, summary: string, maxBytes: number): ToolResult {
  return Buffer.byteLength(JSON.stringify(data), "utf8") <= maxBytes
    ? success(data, summary) : databaseFailure("DATABASE_RESULT_LIMIT");
}

function safeCell(column: string, raw: unknown): { value: string | number | null; redacted: boolean } {
  if (SENSITIVE_COLUMN.test(column) || raw instanceof Uint8Array) return { value: "[REDACTED]", redacted: true };
  if (raw === null) return { value: null, redacted: false };
  if (typeof raw === "bigint") return { value: raw.toString(), redacted: false };
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { value: "[REDACTED]", redacted: true };
    return { value: raw, redacted: false };
  }
  if (typeof raw === "string") {
    if (sensitiveContentReason(raw)) return { value: "[REDACTED]", redacted: true };
    return { value: raw, redacted: false };
  }
  return { value: "[REDACTED]", redacted: true };
}

async function withSnapshot<T>(bytes: Buffer, work: (database: DatabaseSync) => T): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "orchestrion-db-readonly-"));
  const path = join(directory, `${randomUUID()}.sqlite`);
  let database: DatabaseSync | undefined;
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    database = new DatabaseSync(path, { readOnly: true });
    database.enableLoadExtension(false);
    database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF");
    return work(database);
  } finally {
    try { database?.close(); } catch { /* cleanup remains best-effort after a typed failure */ }
    await rm(directory, { recursive: true, force: true, maxRetries: 2 });
  }
}

type TableListRow = { schema: unknown; name: unknown; type: unknown };

function mainTableList(database: DatabaseSync): Array<{ name: string; type: string }> {
  const rows = database.prepare("PRAGMA main.table_list").all() as unknown as TableListRow[];
  if (rows.some((row) => row.schema !== "main" || typeof row.name !== "string" || typeof row.type !== "string")) {
    throw new Error("invalid table list");
  }
  return rows.map((row) => ({ name: row.name as string, type: row.type as string }));
}

function ordinaryTable(database: DatabaseSync, table: string): boolean {
  const matches = mainTableList(database).filter((row) => row.name === table);
  return matches.length === 1 && matches[0].type === "table";
}

function query(database: DatabaseSync, args: QueryArguments, scope: DatabaseEffectiveScope): ToolResult {
  const table = /^SELECT\s+(?:\*|[A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(args.sql)![1];
  if (!ordinaryTable(database, table)) return databaseFailure("DATABASE_QUERY_INVALID");
  const statement = database.prepare(args.sql);
  statement.setAllowBareNamedParameters(false);
  statement.setReadBigInts(true);
  const columns = statement.columns().map((column) => column.name);
  if (columns.some((name) => !IDENTIFIER.test(name) || RESERVED_IDENTIFIER.has(name))
      || new Set(columns).size !== columns.length) return databaseFailure("DATABASE_QUERY_INVALID");
  const rows: Record<string, string | number | null>[] = [];
  let redacted = 0;
  const values = args.parameters ? statement.iterate(args.parameters) : statement.iterate();
  for (const value of values) {
    if (rows.length >= scope.max_rows) return boundedSuccess({ connection_name: args.connection_name, columns, rows,
      row_count: rows.length, truncated: true, redacted_cells: redacted }, "Database query completed with bounded truncation", scope.max_result_bytes);
    const row: Record<string, string | number | null> = {};
    for (const column of columns) {
      const cell = safeCell(column, (value as Record<string, unknown>)[column]);
      row[column] = cell.value; if (cell.redacted) redacted++;
    }
    rows.push(row);
    if (Buffer.byteLength(JSON.stringify(rows), "utf8") > scope.max_result_bytes) return databaseFailure("DATABASE_RESULT_LIMIT");
  }
  return boundedSuccess({ connection_name: args.connection_name, columns, rows,
    row_count: rows.length, truncated: false, redacted_cells: redacted }, "Database query completed", scope.max_result_bytes);
}

function schema(database: DatabaseSync, args: SchemaArguments, scope: DatabaseEffectiveScope): ToolResult {
  if (!args.table_name) {
    const present = new Set(mainTableList(database)
      .filter((row) => row.type === "table" && !row.name.startsWith("sqlite_"))
      .map((row) => row.name));
    return boundedSuccess({ connection_name: args.connection_name,
      tables: scope.allowed_tables.filter((name) => present.has(name)).map((name) => ({ name })) },
    "Database schema listed", scope.max_result_bytes);
  }
  if (!ordinaryTable(database, args.table_name)) return databaseFailure("DATABASE_QUERY_INVALID");
  const statement = database.prepare("SELECT name, type, \"notnull\", pk FROM pragma_table_info(?) ORDER BY cid");
  const columns = (statement.all(args.table_name) as Array<{ name: string; type: string; notnull: number; pk: number }>).map((row) => ({
    name: row.name, type: row.type, nullable: row.notnull === 0, primary_key: row.pk > 0,
  }));
  return boundedSuccess({ connection_name: args.connection_name, table: args.table_name, columns },
    "Database table schema inspected", scope.max_result_bytes);
}

export async function executeDatabaseSnapshot(bytes: Buffer, tool: DatabaseExecutionRequest["tool"],
  args: DatabaseExecutionRequest["arguments"], scope: DatabaseEffectiveScope): Promise<ToolResult> {
  try {
    return await withSnapshot(bytes, (database) => tool === DATABASE_QUERY_TOOL
      ? query(database, args as QueryArguments, scope) : schema(database, args as SchemaArguments, scope));
  } catch { return databaseFailure("DATABASE_QUERY_INVALID"); }
}

function implementation(context: LocalContext, implementationGroupId: string, executor: LocalDatabaseExecutor,
  value: ReadyConnection, tool: typeof DATABASE_QUERY_TOOL | typeof DATABASE_SCHEMA_TOOL): ToolImplementation {
  const declared = definition(context, implementationGroupId, value, tool);
  const adapter = async (request: DatabaseAdapterRequest): Promise<ToolResult> => {
    if (!request || request.plan.anchor.tool_name !== tool
        || request.plan.connection.connectionId !== value.connectionId) return databaseFailure("DATABASE_AUTHORITY_INVALID");
    try {
      const scope = effectiveScope(request.plan.scope, value);
      const args = tool === DATABASE_QUERY_TOOL
        ? normalizeQuery({ arguments: request.plan.arguments, scope: request.plan.scope }, value)
        : normalizeSchema({ arguments: request.plan.arguments, scope: request.plan.scope }, value);
      return await executor({ authority: request.authority, relativePath: value.relativePath, tool, arguments: args, scope,
        ...(request.signal ? { signal: request.signal } : {}) });
    } catch (error) {
      const code = error instanceof DatabaseAdapterError ? error.code : "DATABASE_QUERY_INVALID";
      return databaseFailure(code);
    }
  };
  return {
    describe: () => structuredClone(declared),
    planner: (input: ToolPlannerInput) => ({ arguments: tool === DATABASE_QUERY_TOOL
      ? normalizeQuery(input, value) : normalizeSchema(input, value),
    claims: [{ type: "workspace_path" as const, value: value.logicalPath, mode: "read" as const }] }),
    adapter: adapter as ToolImplementation["adapter"],
    planningReview: { version: "database-sqlite-readonly-plan-v1", effect: "read_only", resourceKind: "logical_workspace_path" },
  };
}

/** Trusted composition helper. The returned implementations still require a
 * direct grant plus live Policy admission before their adapters are reachable. */
export function databaseImplementations(context: LocalContext, implementationGroupId: string,
  executor: LocalDatabaseExecutor, raw: unknown): ToolImplementation[] {
  const value = connection(raw, context);
  return ([DATABASE_QUERY_TOOL, DATABASE_SCHEMA_TOOL] as const)
    .map((tool) => implementation(context, implementationGroupId, executor, value, tool));
}
