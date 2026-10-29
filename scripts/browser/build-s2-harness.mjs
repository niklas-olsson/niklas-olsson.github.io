// SPDX-License-Identifier: Apache-2.0
// Bundle actual production storage/migration APIs into a separate acceptance
// helper. It is never imported by the shipped application and is not a mock.
import { build } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const outDir = resolve(process.env.TERRARIUM_S2_HELPER_DIR ?? resolve(root, ".cache/s2-browser-helper"));
if (!outDir.startsWith(root)) throw new Error("Keep the acceptance helper within this project.");
await build({ configFile: false, root, publicDir: false, logLevel: "warn", build: {
  target: "es2022", outDir, emptyOutDir: true, minify: false,
  lib: { entry: resolve(root, "scripts/browser/s2-browser-helper.ts"), formats: ["es"], fileName: () => "s2-browser-helper.js" },
} });
console.log(`S2_BROWSER_HELPER_BUILD_COMPLETE ${outDir}`);
