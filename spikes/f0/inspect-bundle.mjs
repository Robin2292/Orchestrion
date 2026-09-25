import assert from "node:assert/strict";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

// Compare both sides in the same filesystem namespace (e.g. /var aliases on macOS).
export async function inspectBundle(app) {
  const canonicalApp = await realpath(app);
  let packagedBytes = 0;
  async function inspect(directory) {
    for (const name of await readdir(directory)) {
      const entry = join(directory, name);
      const info = await lstat(entry);
      if (info.isSymbolicLink()) {
        const delta = relative(canonicalApp, await realpath(entry));
        assert.ok(
          delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta),
          "bundle symlink escaped",
        );
      } else if (info.isDirectory()) await inspect(entry);
      else packagedBytes += info.size;
    }
  }
  await inspect(canonicalApp);
  return packagedBytes;
}
