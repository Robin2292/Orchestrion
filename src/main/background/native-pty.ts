import { createRequire } from "node:module";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { WorkspacePtyFactory } from "../workspace-terminal";

/** Load only the relocatable product build artifact, never a fallback to the
 * installed dependency cache. Packaging damage fails closed; no runtime chmod. */
export function packagedPtyFactory(assetRoot: string): WorkspacePtyFactory {
  const require = createRequire(import.meta.url);
  return {
    spawn(options, assertActive) {
      const helper = statSync(join(assetRoot, "prebuilds/darwin-arm64/spawn-helper"));
      if (!helper.isFile() || (helper.mode & 0o111) !== 0o111) throw new Error("Native PTY asset is not executable");
      const { spawn } = require(assetRoot) as typeof import("node-pty");
      assertActive?.(); // after module load, immediately before the native effect
      return spawn(options.shell, options.args, {
        name: "xterm-256color", cols: options.columns, rows: options.rows,
        cwd: options.cwd, env: options.env,
      });
    },
  };
}
