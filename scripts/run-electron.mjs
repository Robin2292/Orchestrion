import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { constants as osConstants } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const PINNED_ELECTRON_VERSION = "38.8.6";
const moduleRequire = createRequire(import.meta.url);

function isOutside(root, candidate) {
  const delta = relative(root, candidate);
  return delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta);
}

function incompleteInstallation(cause) {
  return new Error(
    `Electron ${PINNED_ELECTRON_VERSION} is incomplete. Run "pnpm install --frozen-lockfile" with lifecycle scripts enabled, then retry.`,
    { cause },
  );
}

export async function resolveElectronExecutable(requireFromLauncher = moduleRequire) {
  let packagePath;
  try {
    packagePath = requireFromLauncher.resolve("electron/package.json");
  } catch (error) {
    throw incompleteInstallation(error);
  }
  const packageDirectory = dirname(packagePath);
  let packageJson;
  try {
    packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  } catch (error) {
    throw incompleteInstallation(error);
  }
  if (packageJson.version !== PINNED_ELECTRON_VERSION) {
    throw new Error(`Expected Electron ${PINNED_ELECTRON_VERSION}, received ${String(packageJson.version)}`);
  }

  let packagedPath;
  try {
    packagedPath = (await readFile(resolve(packageDirectory, "path.txt"), "utf8")).trim();
  } catch (error) {
    throw incompleteInstallation(error);
  }
  if (!packagedPath || packagedPath.includes("\0") || isAbsolute(packagedPath)) {
    throw new Error("Electron package path is invalid");
  }

  const distributionPath = resolve(packageDirectory, "dist");
  const candidatePath = resolve(distributionPath, packagedPath);
  if (isOutside(distributionPath, candidatePath)) {
    throw new Error("Electron executable path escapes its package distribution");
  }

  let resolvedDistribution;
  let executable;
  try {
    resolvedDistribution = await realpath(distributionPath);
    executable = await realpath(candidatePath);
  } catch (error) {
    throw incompleteInstallation(error);
  }
  if (isOutside(resolvedDistribution, executable)) {
    throw new Error("Electron executable resolves outside its package distribution");
  }

  try {
    const metadata = await stat(executable);
    if (!metadata.isFile()) throw new Error("Electron executable is not a file");
    await access(executable, process.platform === "win32" ? constants.F_OK : constants.X_OK);
  } catch (error) {
    throw incompleteInstallation(error);
  }
  return executable;
}

export function launchElectron({
  executable,
  args,
  env = process.env,
  spawnChild = spawn,
}) {
  return new Promise((resolveChild, rejectChild) => {
    let child;
    try {
      child = spawnChild(executable, args, { stdio: "inherit", env, shell: false });
    } catch (error) {
      rejectChild(error);
      return;
    }
    child.once("error", rejectChild);
    child.once("exit", (code, signal) => resolveChild({ code, signal }));
  });
}

function exitCodeForSignal(signal) {
  const signalNumber = osConstants.signals[signal];
  return typeof signalNumber === "number" ? 128 + signalNumber : 1;
}

async function main() {
  const executable = await resolveElectronExecutable();
  const result = await launchElectron({ executable, args: process.argv.slice(2) });
  if (result.signal) process.stderr.write(`Electron exited via ${result.signal}\n`);
  process.exitCode = result.code ?? (result.signal ? exitCodeForSignal(result.signal) : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
