import { resolve } from "node:path";
import type { ResolvedExecutionAuthority } from "./execution-authority";
import { readWorkspaceFileBounded } from "./workspace-files";
import {
  DatabaseAdapterError,
  MAX_DATABASE_BYTES,
  databaseFailure,
  executeDatabaseSnapshot,
  type DatabaseExecutionRequest,
} from "../tools/database/sqlite-readonly";

const authorityToken = Symbol("database-workspace-authority");

/** Host-minted, point-in-time workspace identity for the database snapshot executor.
 * It grants no Tool or Policy authority; T2 admission still owns that decision. */
export class DatabaseWorkspaceAuthority {
  private constructor(token: symbol, private readonly rootPath: string,
    private readonly root: { canonicalPath: string; dev: number; ino: number }) {
    if (token !== authorityToken) throw new DatabaseAdapterError("DATABASE_AUTHORITY_INVALID");
  }

  static fromExecutionAuthority(authority: ResolvedExecutionAuthority): DatabaseWorkspaceAuthority {
    if (authority.placement.placement !== "local_trusted" || authority.placement.workspace.kind !== "local_folder"
        || authority.workspace.kind !== "local_folder" || authority.context.project_id !== authority.project.id
        || resolve(authority.project.path) !== resolve(authority.placement.workspace.path)
        || authority.project.canonicalPath !== authority.workspace.canonical_path) {
      throw new DatabaseAdapterError("DATABASE_AUTHORITY_INVALID");
    }
    return new DatabaseWorkspaceAuthority(authorityToken, authority.project.path, {
      canonicalPath: authority.workspace.canonical_path, dev: authority.workspace.dev, ino: authority.workspace.ino,
    });
  }

  async snapshot(relativePath: string, signal?: AbortSignal): Promise<Buffer> {
    try {
      const read = await readWorkspaceFileBounded(this.rootPath, relativePath, MAX_DATABASE_BYTES, undefined, signal);
      if (read.symlinked || read.canonicalRelativePath !== relativePath
          || read.root.canonicalPath !== this.root.canonicalPath || read.root.dev !== this.root.dev || read.root.ino !== this.root.ino) {
        throw new Error();
      }
      return read.bytes;
    } catch { throw new DatabaseAdapterError("DATABASE_SNAPSHOT_INVALID"); }
  }
}

/** Trusted host adapter injected into direct Tool composition. The untrusted request
 * cannot manufacture the nominal workspace authority checked here. */
export class LocalDatabaseSnapshotExecutor {
  async execute(request: DatabaseExecutionRequest) {
    if (!(request.authority instanceof DatabaseWorkspaceAuthority)) return databaseFailure("DATABASE_AUTHORITY_INVALID");
    try {
      const bytes = await request.authority.snapshot(request.relativePath, request.signal);
      return await executeDatabaseSnapshot(bytes, request.tool, request.arguments, request.scope);
    } catch (error) {
      return databaseFailure(error instanceof DatabaseAdapterError ? error.code : "DATABASE_SNAPSHOT_INVALID");
    }
  }
}
