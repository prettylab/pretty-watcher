import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    target: "node18",
    platform: "node",
    clean: false,
    sourcemap: true,
  },
  {
    // npx pretty manager pair|unpair|status
    entry: ["src/cli.ts"],
    format: ["esm"],
    target: "node22",
    platform: "node",
  },
]);
