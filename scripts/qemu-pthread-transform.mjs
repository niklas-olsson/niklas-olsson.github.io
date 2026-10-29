// SPDX-License-Identifier: Apache-2.0
// The derived loader retains its upstream MIT license. This transform is owned
// source and never rewrites the verified QEMU module or Wasm bytes.
import { createHash } from "node:crypto";

export const UPSTREAM_PTHREAD_SHA256 = "d5093486d6528279893f00b58b6ae75843f9bf687c91fca7e30bc07551a6761c";
export const PTHREAD_TRANSFORM_ID = "terrarium-browser-pthread-locate-file-v1";
export const OWNED_PTHREAD_SHA256 = "9bc24c5cde340cd0b3c2e7363a3b4d2963e0780b706aac4068577fd33005f2ff";
export const OWNED_PTHREAD_TRANSFORM_ID = "terrarium-owned-pthread-locate-file-v1";

/** The pthread already receives compiled Wasm; this URL is resolved, not fetched. */
export function resolvePthreadWasmPath(path, locationHref) {
  if (path !== "qemu-system-x86_64.wasm")
    throw new Error("Unconfigured QEMU pthread asset: " + path);
  return new URL(path, locationHref).href;
}

export function transformQemuPthread(source) {
  const bytes = typeof source === "string" ? Buffer.from(source) : source;
  if (createHash("sha256").update(bytes).digest("hex") !== UPSTREAM_PTHREAD_SHA256)
    throw new Error("The original QEMU pthread loader does not match its pinned upstream SHA-256.");
  const original = Buffer.from(bytes).toString("utf8");
  const marker = "      Module['ENVIRONMENT_IS_PTHREAD'] = true;\n";
  if (original.split(marker).length !== 2)
    throw new Error("The pinned pthread loader's initialization point is ambiguous.");
  const addition = `
      // Terrarium ${PTHREAD_TRANSFORM_ID}.
      // The verified module is imported from a Blob URL in browsers. Its
      // eager relative Wasm URL resolution needs this bounded location hook,
      // even though instantiateWasm uses the module posted by the parent.
      // Node keeps its existing file-URL behavior and unmodified environment.
      if (!ENVIRONMENT_IS_NODE) {
        Module['locateFile'] = (path) => (${resolvePthreadWasmPath.toString()})(path, self.location.href);
      }
`;
  return original.replace(marker, marker + addition);
}

/** The separately measured, minified output of the owned Emscripten 3.1.50 build. */
export function transformOwnedQemuPthread(source) {
  const bytes = typeof source === "string" ? Buffer.from(source) : source;
  if (createHash("sha256").update(bytes).digest("hex") !== OWNED_PTHREAD_SHA256)
    throw new Error("The original owned QEMU pthread loader does not match its measured SHA-256.");
  const original = Buffer.from(bytes).toString("utf8");
  const marker = 'Module["ENVIRONMENT_IS_PTHREAD"]=true;';
  if (original.split(marker).length !== 2)
    throw new Error("The measured owned pthread initialization point is ambiguous.");
  const addition = `\n// Terrarium ${OWNED_PTHREAD_TRANSFORM_ID}; bounded browser URL resolution only.\nif (!ENVIRONMENT_IS_NODE) { Module["locateFile"] = (path) => (${resolvePthreadWasmPath.toString()})(path, self.location.href); }\n`;
  return "// SPDX-License-Identifier: MIT\n// Emscripten generated pthread bootstrap; see ../../Emscripten-LICENSE.txt.\n"
    + original.replace(marker, marker + addition);
}
