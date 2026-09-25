import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { launchElectron, resolveElectronExecutable } from "./run-electron.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "orchestrion-terminal-lifecycle-"));
const generatedRoot = join(temporary, "src");
const serviceBundle = join(generatedRoot, "main/workspace-terminal.mjs");

async function transpile(sourcePath, outputPath, rewrite = (source) => source) {
  const source = rewrite(await readFile(sourcePath, "utf8"));
  const result = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
    fileName: sourcePath,
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, result.outputText, "utf8");
}

try {
  await symlink(join(projectRoot, "node_modules"), join(temporary, "node_modules"), "dir");
  await transpile(join(projectRoot, "src/shared/contracts.ts"), join(generatedRoot, "shared/contracts.mjs"));
  await transpile(
    join(projectRoot, "src/main/workspace-terminal.ts"),
    serviceBundle,
    (source) => source.replace('"../shared/contracts"', '"../shared/contracts.mjs"'),
  );
  const executable = await resolveElectronExecutable();
  const harness = join(projectRoot, "scripts/native-workspace-lifecycle-smoke.mjs");
  const result = await launchElectron({ executable, args: [harness, serviceBundle] });
  if (result.code !== 0 || result.signal) {
    throw new Error(`Workspace lifecycle smoke failed (${result.signal ?? result.code ?? "unknown exit"})`);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
