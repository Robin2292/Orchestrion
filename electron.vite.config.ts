import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { chmod, cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { execFileSync } from "node:child_process";

function keychainAssets(): Plugin {
  let output = "";
  return {
    name: "orchestrion-keychain-assets",
    configResolved(config) { output = resolve(config.root, config.build.outDir, "native/keychain.node"); },
    async writeBundle() {
      if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Keychain requires macOS arm64");
      // Stable Node-API only. Build-time headers follow the selected Node install;
      // the packaged artifact has no header/compiler/runtime cache dependency.
      const include = resolve(dirname(process.execPath), "../include/node");
      await stat(join(include, "node_api.h"));
      await mkdir(dirname(output), { recursive: true });
      execFileSync("/usr/bin/clang", ["-bundle", "-undefined", "dynamic_lookup", "-arch", "arm64",
        "-mmacosx-version-min=12.0", "-I", include, "-framework", "Security", "-framework", "CoreFoundation",
        "-framework", "LocalAuthentication", "-fobjc-arc", "-Wall", "-Wextra", "-Werror", resolve("native/keychain.m"), "-o", output], { stdio: "pipe" });
    },
  };
}

/** Product build/dev-watch asset guarantee. Never mutate the package-manager
 * cache: stage the pinned native module beside the emitted utility entry. Future
 * installers must ship this native directory outside ASAR and preserve its modes. */
function nativePtyAssets(): Plugin {
  let output = "";
  const require = createRequire(import.meta.url);
  const source = dirname(require.resolve("node-pty/package.json"));
  return {
    name: "orchestrion-native-pty-assets",
    configResolved(config) { output = resolve(config.root, config.build.outDir, "native/node-pty"); },
    async writeBundle() {
      if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("F3 native assets require the frozen macOS arm64 target");
      const metadata = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
      if (metadata.version !== "1.1.0") throw new Error("Unexpected node-pty version");
      await rm(output, { recursive: true, force: true });
      await mkdir(output, { recursive: true });
      for (const name of ["package.json", "LICENSE", "lib", "prebuilds/darwin-arm64"]) {
        await cp(join(source, name), join(output, name), { recursive: true, dereference: true });
      }
      const helper = join(output, "prebuilds/darwin-arm64/spawn-helper");
      await chmod(helper, 0o755);
      const info = await stat(helper);
      if (!info.isFile() || (info.mode & 0o777) !== 0o755) throw new Error("Native PTY helper is not executable in build output");
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), nativePtyAssets(), keychainAssets()],
    build: { rollupOptions: { input: {
      index: resolve("src/main/index.ts"), background: resolve("src/main/background/entry.ts"),
    } } },
  },
  preload: {
    // Sandboxed preload cannot require npm modules at runtime.
    plugins: [externalizeDepsPlugin({ exclude: ["zod"] })],
    build: {
      lib: { entry: resolve("src/preload/index.ts"), formats: ["cjs"] },
      rollupOptions: {
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    resolve: {
      alias: { "@renderer": resolve("src/renderer") },
      dedupe: ["react", "react-dom"],
    },
    plugins: [react()],
  },
});
