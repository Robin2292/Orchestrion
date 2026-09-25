import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ToolPlannerInput } from "../../shared/tool-invocation-contracts";
import type { ToolDefinition } from "../../shared/tool-registry-contracts";
import {
  DATABASE_QUERY_TOOL,
  DATABASE_SCHEMA_TOOL,
  databaseDriverReadiness,
  databaseImplementations,
  executeDatabaseSnapshot,
  type DatabaseEffectiveScope,
} from "./sqlite-readonly";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const context = { org_id: "org", project_id: "project", principal: { type: "user" as const, id: "owner" } };
const raw = {
  context, connectionId: "reporting-local", driver: "sqlite" as const,
  databasePath: "data/reporting.sqlite", credentialRef: null,
  maxRows: 2, maxResultBytes: 4096, allowedTables: ["records"],
};
const scope: DatabaseEffectiveScope = {
  workspace_dir: "/workspace/data/reporting.sqlite", connection_id: raw.connectionId, driver: "sqlite",
  max_rows: raw.maxRows, max_result_bytes: raw.maxResultBytes, allowed_tables: raw.allowedTables,
};

function snapshot(setup = "") {
  const root = mkdtempSync(join(tmpdir(), "orclocal-database-direct-")); roots.push(root);
  const path = join(root, "fixture.sqlite"), database = new DatabaseSync(path);
  database.exec("CREATE TABLE records(id INTEGER PRIMARY KEY, name TEXT NOT NULL, password TEXT, note TEXT);"
    + "INSERT INTO records VALUES (1,'alpha','first-secret','ordinary');"
    + "INSERT INTO records VALUES (2,'beta','second-secret','AKIA1234567890ABCDEF');"
    + "INSERT INTO records VALUES (3,'gamma','third-secret','ordinary');" + setup);
  database.close();
  return readFileSync(path);
}

describe("direct-only Local SQLite adapter", () => {
  it("publishes inert contracts and rejects invalid configuration or write planning", () => {
    const executor = vi.fn();
    const implementations = databaseImplementations(context, "database-source", executor, raw);
    expect(implementations.map((implementation) => (implementation.describe() as ToolDefinition).name))
      .toEqual([DATABASE_QUERY_TOOL, DATABASE_SCHEMA_TOOL]);
    expect(implementations.every((implementation) => (implementation.describe() as ToolDefinition).sourceId === "database-source")).toBe(true);
    expect(databaseDriverReadiness("sqlite")).toEqual({ executionReady: true, reason: null });
    expect(databaseDriverReadiness("postgresql")).toEqual({ executionReady: false, reason: "DATABASE_DRIVER_UNAVAILABLE" });
    expect(() => databaseImplementations(context, "database-source", executor, { ...raw, driver: "postgresql" }))
      .toThrow("DATABASE_DRIVER_UNAVAILABLE");
    expect(() => databaseImplementations(context, "database-source", executor, {
      ...raw, context: { ...context, org_id: "foreign" },
    })).toThrow("DATABASE_CONFIG_INVALID");
    const query = implementations[0];
    const plan = query.planner as unknown as (input: ToolPlannerInput) => unknown;
    expect(plan({ arguments: { connection_name: raw.connectionId,
      sql: "SELECT id, name FROM records WHERE id = :wanted", parameters: { wanted: 2 } }, scope }))
      .toMatchObject({ arguments: { parameters: { ":wanted": 2 } }, claims: [{ mode: "read" }] });
    for (const sql of ["INSERT INTO records VALUES (4,'x','y','z')", "SELECT * FROM records; DELETE FROM records",
      "SELECT * FROM sqlite_schema", "SELECT * FROM records LIMIT 3"]) {
      expect(() => plan({ arguments: { connection_name: raw.connectionId, sql }, scope })).toThrow();
    }
    expect(executor).not.toHaveBeenCalled();
  });

  it("bounds rows, redacts secret cells, and never changes the reviewed snapshot", async () => {
    const bytes = snapshot(), before = Buffer.from(bytes);
    const result = await executeDatabaseSnapshot(bytes, DATABASE_QUERY_TOOL, {
      connection_name: raw.connectionId, sql: "SELECT id, name, password, note FROM records ORDER BY id",
    }, scope);
    expect(result).toMatchObject({ success: true, data: {
      row_count: 2, truncated: true, redacted_cells: 3,
      rows: [
        { id: "1", name: "alpha", password: "[REDACTED]", note: "ordinary" },
        { id: "2", name: "beta", password: "[REDACTED]", note: "[REDACTED]" },
      ],
    } });
    expect(bytes).toEqual(before);
  });

  it("rejects virtual or shadow tables and output beyond the reviewed byte ceiling", async () => {
    const bytes = snapshot("CREATE VIRTUAL TABLE search USING fts5(body); INSERT INTO search(body) VALUES ('indexed');");
    const virtualScope = { ...scope, allowed_tables: ["records", "search"], max_result_bytes: 1024 };
    expect(await executeDatabaseSnapshot(bytes, DATABASE_SCHEMA_TOOL, {
      connection_name: raw.connectionId, table_name: "search",
    }, virtualScope)).toMatchObject({ success: false, errorCode: "DATABASE_QUERY_INVALID" });
    expect(await executeDatabaseSnapshot(bytes, DATABASE_QUERY_TOOL, {
      connection_name: raw.connectionId, sql: "SELECT * FROM search",
    }, virtualScope)).toMatchObject({ success: false, errorCode: "DATABASE_QUERY_INVALID" });
    const oversized = snapshot("UPDATE records SET note = printf('%.*c', 2048, 'x') WHERE id = 1;");
    expect(await executeDatabaseSnapshot(oversized, DATABASE_QUERY_TOOL, {
      connection_name: raw.connectionId, sql: "SELECT note FROM records WHERE id = :wanted", parameters: { ":wanted": 1 },
    }, { ...scope, max_result_bytes: 1024 })).toMatchObject({ success: false, errorCode: "DATABASE_RESULT_LIMIT" });
  });
});
