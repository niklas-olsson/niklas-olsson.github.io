// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { adaptQemuModuleForNode } from "../../scripts/qemu-node-glue.mjs";
import { LEGACY_QEMU_BUNDLE_ID, QEMU_BUNDLES } from "./qemu-assets.ts";

for (const bundle of Object.values(QEMU_BUNDLES).filter(value => value.nodeAdapter === "owned-minified-cpu-websocket-bindings-v1")) {
const ownedUrl = new URL("../../public/" + bundle.assets.module.url, import.meta.url);

test(`the Node binding adapts only exact measured ${bundle.id} glue and preserves browser input bytes`, async () => {
  const original = await readFile(ownedUrl);
  const source = original.toString("utf8");
  const adapted = adaptQemuModuleForNode(original, bundle.id);
  assert.equal(adapted, adaptQemuModuleForNode(source, bundle.id));
  assert.equal(adapted, source
    .replace('require("os").cpus().length', 'Math.max(1, require("os").cpus().length || require("os").availableParallelism())')
    .replace('WebSocketConstructor=require("ws")', 'WebSocketConstructor=globalThis.WebSocket'));
  assert.ok(adapted.includes('WebSocketServer=require("ws").Server'), "Only the client constructor is the existing engine binding.");
  assert.equal(createHash("sha256").update(original).digest("hex"), bundle.assets.module.sha256);
});

test(`Node glue adaptation for ${bundle.id} rejects altered bytes and mismatched or unregistered identities`, async () => {
  const original = await readFile(ownedUrl);
  const changed = Buffer.from(original); changed[changed.length - 1] ^= 1;
  assert.throws(() => adaptQemuModuleForNode(changed, bundle.id), /measured SHA-256/);
  assert.throws(() => adaptQemuModuleForNode(original.subarray(1), bundle.id), /exact selected module bytes/);
  assert.throws(() => adaptQemuModuleForNode(original, LEGACY_QEMU_BUNDLE_ID), /exact selected module bytes/);
  assert.throws(() => adaptQemuModuleForNode(original, "foreign" as never), /compatibility identity/);
});
}
