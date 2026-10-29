// SPDX-License-Identifier: Apache-2.0
// Node-only bindings. Browser execution always imports the original pinned glue.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getQemuBundle } from "../public/runtime/qemu/bundles.js";

function replaceOnce(source, search, replacement) {
  assert.equal(source.split(search).length - 1, 1, `Expected exactly one Node adapter site: ${search}`);
  return source.replace(search, replacement);
}

export function adaptQemuModuleForNode(bytes, bundleId) {
  const bundle = getQemuBundle(bundleId);
  const input = Buffer.from(bytes);
  assert.equal(input.length, bundle.assets.module.bytes, "The Node adapter requires the exact selected module bytes.");
  assert.equal(createHash("sha256").update(input).digest("hex"), bundle.assets.module.sha256,
    "The Node adapter requires the selected module's measured SHA-256.");
  let source = replaceOnce(input.toString("utf8"), 'require("os").cpus().length',
    'Math.max(1, require("os").cpus().length || require("os").availableParallelism())');
  if (bundle.nodeAdapter === "legacy-cpu-websocket-bindings-v1")
    source = replaceOnce(source, '(require("ws"))', '(globalThis.WebSocket)');
  else if (bundle.nodeAdapter === "owned-minified-cpu-websocket-bindings-v1")
    source = replaceOnce(source, 'WebSocketConstructor=require("ws")', 'WebSocketConstructor=globalThis.WebSocket');
  else throw new Error("No checked Node glue binding exists for this QEMU bundle.");
  return source;
}
