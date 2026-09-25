import { spawn, type ChildProcess } from "node:child_process";
import type { WorkspaceFileOpenDestination } from "../shared/contracts";
import { resolveProjectFilePath } from "./workspace-files";

export interface WorkspaceFileLaunchAdapter {
  openSystem(path: string, assertActive?: () => void): Promise<string>;
  spawn(executable: string, args: readonly string[]): ChildProcess;
}

export interface OpenProjectFileOptions {
  launcher?: WorkspaceFileLaunchAdapter;
  platform?: NodeJS.Platform;
  assertActive?: () => void;
}

const nodeLauncher: WorkspaceFileLaunchAdapter = {
  async openSystem(path, assertActive?: () => void) {
    const { shell } = await import("electron");
    assertActive?.();
    return shell.openPath(path);
  },
  spawn(executable, args) {
    return spawn(executable, [...args], { detached: true, shell: false, stdio: "ignore" });
  },
};

export async function openProjectFile(
  projectRoot: string,
  relativePath: string,
  destination: WorkspaceFileOpenDestination,
  options: OpenProjectFileOptions = {},
): Promise<void> {
  if (destination !== "system" && destination !== "vscode" && destination !== "cursor") {
    throw new Error("Unsupported workspace file destination");
  }
  options.assertActive?.();
  const target = await resolveProjectFilePath(projectRoot, relativePath);
  const launcher = options.launcher ?? nodeLauncher;
  if (destination === "system") {
    options.assertActive?.();
    const failure = await (options.launcher ? launcher.openSystem(target) : launcher.openSystem(target, options.assertActive));
    if (failure) throw new Error(`Could not open workspace file: ${failure}`);
    return;
  }

  const invocation = editorInvocation(destination, target, options.platform ?? process.platform);
  options.assertActive?.();
  const child = launcher.spawn(invocation.executable, invocation.args);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", () => reject(new Error(`${displayName(destination)} is not available`)));
  });
}

function editorInvocation(
  destination: Exclude<WorkspaceFileOpenDestination, "system">,
  target: string,
  platform: NodeJS.Platform,
): { executable: string; args: readonly string[] } {
  if (platform === "darwin") {
    return {
      executable: "/usr/bin/open",
      args: ["-a", destination === "vscode" ? "Visual Studio Code" : "Cursor", "--", target],
    };
  }
  if (platform === "win32") {
    return { executable: destination === "vscode" ? "code.exe" : "cursor.exe", args: ["--", target] };
  }
  return { executable: destination === "vscode" ? "code" : "cursor", args: ["--", target] };
}

function displayName(destination: Exclude<WorkspaceFileOpenDestination, "system">): string {
  return destination === "vscode" ? "Visual Studio Code" : "Cursor";
}
