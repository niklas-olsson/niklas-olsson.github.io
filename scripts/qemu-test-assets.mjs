// SPDX-License-Identifier: Apache-2.0
// Shared fixture preparation for real guest tests. This selects only immutable
// production catalog entries and verifies bytes; it never substitutes a guest.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DEFAULT_QEMU_BUNDLE_ID } from "../public/runtime/qemu/catalog.js";
import { assertQemuBundleManifest, getQemuBundle } from "../public/runtime/qemu/bundles.js";

export const selectedQemuBundle = getQemuBundle(process.env.TERRARIUM_QEMU_BUNDLE_ID ?? DEFAULT_QEMU_BUNDLE_ID);
export const qemuTestOrigin = "https://terrarium.invalid/";

function verify(bytes, pin, description) {
  assert.equal(bytes.byteLength, pin.bytes, `${description}: byte length`);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), pin.sha256, `${description}: SHA-256`);
  return bytes;
}

export async function loadQemuTestAssets({ bundle = selectedQemuBundle, fetchAsset = globalThis.fetch, cacheDirectory = process.env.TERRARIUM_QEMU_ASSET_DIR } = {}) {
  const directory = new URL("../public/runtime/qemu/", import.meta.url);
  const manifestBytes = verify(await readFile(new URL(bundle.manifest.file, directory)), bundle.manifest, "Package manifest");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assertQemuBundleManifest(manifest, bundle);
  const pthread = verify(await readFile(new URL(bundle.pthread.file, directory)), bundle.pthread, "Pthread loader");
  const assets = new Map();
  for (const asset of Object.values(bundle.assets)) {
    const url = new URL(asset.url, qemuTestOrigin);
    let bytes;
    if (cacheDirectory) bytes = await readFile(join(cacheDirectory, basename(url.pathname)));
    else if (url.origin === new URL(qemuTestOrigin).origin) bytes = await readFile(new URL("../public/" + url.pathname.slice(1), import.meta.url));
    else {
      assert.equal(url.protocol, "https:", "Only pinned HTTPS downloads are supported.");
      const response = await fetchAsset(url, { credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(120_000) });
      assert.ok(response.ok, `${asset.name}: HTTP ${response.status}`);
      bytes = new Uint8Array(await response.arrayBuffer());
    }
    assets.set(url.href, verify(bytes, asset, asset.name));
  }
  console.log(`Verified runtime bundle ${bundle.id}: exact module, Wasm, kernel, root, firmware, manifest and pthread bytes.`);
  return { bundle, manifest, pthread, assets };
}

export async function installQemuTestPthread(temporary, bundle, pthread) {
  const path = join(temporary, bundle.pthread.file);
  await mkdir(dirname(path), { recursive: true });
  // These exact generated .js loaders use CommonJS in Node. A temporary
  // directory may be inside this ES-module project (for example TMPDIR in
  // recovery), so make their package scope explicit without rewriting bytes.
  // The separately generated runtime-*.mjs module remains an ES module.
  const packagePath = join(dirname(path), "package.json");
  const packageScope = '{"private":true,"type":"commonjs"}\n';
  try { await writeFile(packagePath, packageScope, { flag: "wx" }); }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (await readFile(packagePath, "utf8") !== packageScope)
      throw new Error("Conflicting temporary pthread package scope; existing package metadata was preserved.");
  }
  await writeFile(path, pthread);
}
