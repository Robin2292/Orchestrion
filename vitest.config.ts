import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "scripts/build-signed-mac.test.mjs", "out/**", "dist/**", "dist-signed/**"] },
  resolve: { dedupe: ["react", "react-dom"] },
});
