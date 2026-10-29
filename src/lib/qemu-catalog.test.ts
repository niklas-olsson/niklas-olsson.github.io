// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  LEGACY_QEMU_BUNDLE_ID, OWNED_QEMU_BUNDLE_ID, PUBLISHED_QEMU_BUNDLE_ID, QEMU_BUNDLES,
  QEMU_PROFILE_ASSETS, QEMU_WASM, getQemuBundle, isSupportedQemuBundleId, resolveQemuAssetUrl,
} from "./qemu-assets.ts";
import { assertQemuBundleManifest, readQemuBundleManifest } from "../../public/runtime/qemu/bundles.js";
import { SERVER_QEMU_V1_BUNDLE_ID, SERVER_QEMU_V2_BUNDLE_ID, SERVER_QEMU_BUNDLE_ID } from "../../public/runtime/qemu/catalog.js";

test("the frozen shared catalog contains identified legacy/owned pins and rejects foreign selectors", async () => {
  assert.deepEqual(Object.keys(QEMU_BUNDLES), [...new Set([
    LEGACY_QEMU_BUNDLE_ID, "qemu@8.2.0-terrarium-0ef7b4e-s1-candidate-v2", OWNED_QEMU_BUNDLE_ID, SERVER_QEMU_V1_BUNDLE_ID, SERVER_QEMU_V2_BUNDLE_ID, SERVER_QEMU_BUNDLE_ID,
  ])]);
  assert.equal(PUBLISHED_QEMU_BUNDLE_ID, LEGACY_QEMU_BUNDLE_ID);
  const bundle = getQemuBundle(LEGACY_QEMU_BUNDLE_ID);
  assert.equal(bundle.assets.wasm, QEMU_WASM);
  assert.equal(bundle.assets.kernel, QEMU_PROFILE_ASSETS["alpine-x86_64"].kernel);
  for (const value of [undefined, null, {}, "__proto__", "constructor", "https://example.invalid/out.js", "qemu@8.2.0-unbuilt",
    "qemu@8.2.0-terrarium-0ef7b4e-s1-candidate-v1"]) {
    assert.equal(isSupportedQemuBundleId(value), false);
    assert.throws(() => getQemuBundle(value), /Unsupported QEMU runtime compatibility/);
  }
  for (const value of [QEMU_BUNDLES, bundle, bundle.assets, ...Object.values(bundle.assets), bundle.guest, bundle.resources, bundle.manifest, bundle.pthread])
    assert.equal(Object.isFrozen(value), true);
  assert.throws(() => Object.assign(bundle.assets.module, { url: "https://untrusted.invalid/out.js" }), TypeError);
  const provenance = JSON.parse(await readFile(new URL("../../public/runtime/qemu/provenance.json", import.meta.url), "utf8"));
  assert.equal(bundle.id, provenance.runtime.checkpointCompatibility);
  for (const [name, asset] of Object.entries(bundle.assets)) {
    assert.equal(asset.sha256, provenance.downloadedAssets[name].sha256, name);
    assert.equal(asset.bytes, provenance.downloadedAssets[name].bytes, name);
  }
  for (const local of [bundle.manifest, bundle.pthread]) {
    assert.match(local.file, /^[a-zA-Z0-9._/-]+$/);
    assert.ok(!local.file.startsWith("/") && !local.file.split("/").includes(".."));
    const bytes = await readFile(new URL(`../../public/runtime/qemu/${local.file}`, import.meta.url));
    assert.equal(bytes.length, local.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), local.sha256);
  }
});

// Public distribution checks bind every catalog entry to the shipped bytes.
// Historical private build receipts are not inputs to a fresh source checkout.
for (const bundle of Object.values(QEMU_BUNDLES).filter(value => value.nodeAdapter === "owned-minified-cpu-websocket-bindings-v1")) {
  test(`owned catalog ${bundle.id} matches distributed bytes and preserves compatibility`, async () => {
    const base = new URL("./", new URL("../../public/" + bundle.assets.module.url, import.meta.url));
    const provenance = JSON.parse(await readFile(new URL("provenance.json", base), "utf8"));
    assert.equal(bundle.id, provenance.runtimeCompatibility);
    assert.equal(bundle.guest.kernel, "6.12.38-0-virt");
    assert.notEqual(bundle.id, PUBLISHED_QEMU_BUNDLE_ID);
    assert.equal(provenance.status, "built-unqualified");
    assert.equal(provenance.runtimeSource.revision, "0ef7b4e2814b231705d8371dd7997f5b72e70baf");
    for (const [key, asset] of Object.entries(bundle.assets)) {
      const bytes = await readFile(new URL("../../public/" + asset.url, import.meta.url));
      assert.equal(bytes.length, asset.bytes, key);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256, key);
      assert.equal(provenance.downloadedAssets[key].bytes, asset.bytes, key);
      assert.equal(provenance.downloadedAssets[key].sha256, asset.sha256, key);
      assert.equal(Object.isFrozen(asset), true);
    }
    for (const asset of [bundle.manifest, bundle.pthread]) {
      const bytes = await readFile(new URL(`../../public/runtime/qemu/${asset.file}`, import.meta.url));
      assert.equal(bytes.length, asset.bytes);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256);
    }
    const source = await readFile(new URL("../../" + provenance.localLoaderSource.file, import.meta.url));
    assert.equal(source.length, provenance.localLoaderSource.bytes);
    assert.equal(createHash("sha256").update(source).digest("hex"), provenance.localLoaderSource.sha256);
    const manifestBytes = new Uint8Array(await readFile(new URL("../../public/runtime/qemu/" + bundle.manifest.file, import.meta.url)));
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    assert.deepEqual(manifest.source, provenance.guestSource.manifestSource);
    assert.deepEqual(manifest.guest, provenance.guest);
    assert.doesNotThrow(() => assertQemuBundleManifest(manifest, bundle));
    await readQemuBundleManifest(new Response(manifestBytes), bundle);
    assert.equal(provenance.runtime.guestMemoryMiB, bundle.memoryMiB);
    assert.equal(provenance.runtime.virtualCpus, bundle.virtualCpus);
    assert.equal(provenance.runtime.sharedWasmMemoryMiB, bundle.resources.reservedWasmMiB);
    if (bundle.id === SERVER_QEMU_BUNDLE_ID) {
      assert.equal(bundle.memoryMiB, 2048);
      assert.equal(bundle.virtualCpus, 2);
      assert.equal(bundle.resources.reservedWasmMiB, 3584);
      assert.equal(bundle.machineMemoryLayout, "split-2x1024m-ram-blocks-v1");
      assert.deepEqual(provenance.runtime.memoryBackendsMiB, [1024, 1024]);
    }
  });
}

test("owned downloads stay under the selected application base and legacy remote URLs remain exact", () => {
  const owned = getQemuBundle(OWNED_QEMU_BUNDLE_ID).assets.module;
  for (const [document, appBase, prefix] of [
    ["https://terrarium.test/index.html", "/", ""],
    ["https://terrarium.test/terrarium/index.html", "./", "/terrarium"],
    ["https://terrarium.test/terrarium/", "/terrarium/", "/terrarium"],
  ]) {
    assert.equal(resolveQemuAssetUrl(owned, document, appBase), `https://terrarium.test${prefix}/${owned.url}`);
    assert.equal(resolveQemuAssetUrl(QEMU_WASM, document, appBase), QEMU_WASM.url);
  }
});

test("the production data-only manifest reader enforces exact bytes, identity and bounded length", async () => {
  const bundle = getQemuBundle(LEGACY_QEMU_BUNDLE_ID);
  const bytes = new Uint8Array(await readFile(new URL(`../../public/runtime/qemu/${bundle.manifest.file}`, import.meta.url)));
  const manifest = await readQemuBundleManifest(new Response(bytes), bundle);
  assert.doesNotThrow(() => assertQemuBundleManifest(manifest, bundle));
  await assert.rejects(readQemuBundleManifest(new Response(null, { status: 503 }), bundle), /could not be loaded/);
  await assert.rejects(readQemuBundleManifest(new Response(bytes.slice(1)), bundle), /incomplete/);
  const altered = bytes.slice(); altered[altered.length - 1] ^= 1;
  await assert.rejects(readQemuBundleManifest(new Response(altered), bundle), /integrity check/);
  const excessive = new Uint8Array(bytes.length + 1); excessive.set(bytes);
  await assert.rejects(readQemuBundleManifest(new Response(excessive), bundle), /exceeds its pinned size/);
  const wrong = JSON.parse(new TextDecoder().decode(bytes));
  wrong.packages.kernel.sha256 = "0".repeat(64);
  assert.throws(() => assertQemuBundleManifest(wrong, bundle), /package pins/);
});
