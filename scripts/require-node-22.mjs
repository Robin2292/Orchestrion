import { pathToFileURL } from "node:url";

export function assertSupportedNodeVersion(version = process.versions.node) {
  const major = Number.parseInt(version.split(".", 1)[0], 10);
  if (major !== 22) {
    throw new Error(`Orchestrion desktop requires Node 22.x; received Node ${version}. Switch runtimes and retry.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertSupportedNodeVersion();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
