// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { transformQemuPthread, UPSTREAM_PTHREAD_SHA256, PTHREAD_TRANSFORM_ID, transformOwnedQemuPthread, OWNED_PTHREAD_SHA256, OWNED_PTHREAD_TRANSFORM_ID } from "./qemu-pthread-transform.mjs";
import { OWNED_QEMU_BUNDLE_ID, QEMU_BUNDLES } from "../public/runtime/qemu/catalog.js";
import { getQemuBundle, assertQemuBundleManifest } from "../public/runtime/qemu/bundles.js";

const directory = new URL("../public/runtime/qemu/", import.meta.url);
const provenance = JSON.parse(await readFile(new URL("provenance.json", directory), "utf8"));
const originalLoader = await readFile(new URL("../vendor/qemu/qemu-system-x86_64.worker.upstream.js", import.meta.url));
const derivedLoader = Buffer.from(transformQemuPthread(originalLoader));
const derivedDigest = createHash("sha256").update(derivedLoader).digest("hex");
const loaderRecord = provenance.localAssets.find((asset) => asset.file === "qemu-system-x86_64.worker.js");
if (provenance.localLoaderSource?.sha256 !== UPSTREAM_PTHREAD_SHA256 ||
    provenance.localLoaderSource?.transformId !== PTHREAD_TRANSFORM_ID ||
    loaderRecord?.bytes !== derivedLoader.length || loaderRecord?.sha256 !== derivedDigest)
  throw new Error("The deterministic pthread transform and its source/derived provenance disagree.");
await writeFile(new URL("qemu-system-x86_64.worker.js", directory), derivedLoader);
const ownedBundles = Object.values(QEMU_BUNDLES).filter(bundle => bundle.nodeAdapter === "owned-minified-cpu-websocket-bindings-v1");
if (!ownedBundles.some(bundle => bundle.id === OWNED_QEMU_BUNDLE_ID))
  throw new Error("The selected owned QEMU candidate has no registered checked loader.");
for (const ownedBundle of ownedBundles) {
  // Every registered owned runtime keeps its own provenance and compatibility
  // ID. Identical guest packs or generated pthreads can be shared by exact pin.
  const modulePath = ownedBundle.assets.module.url;
  if (!/^runtime\/qemu\/bundles\/[a-zA-Z0-9][a-zA-Z0-9._-]*\/out\.js$/.test(modulePath))
    throw new Error("An owned QEMU module must identify a fixed local bundle directory.");
  const provenancePath = modulePath.slice("runtime/qemu/".length).replace(/out\.js$/, "provenance.json");
  const ownedProvenance = JSON.parse(await readFile(new URL(provenancePath, directory), "utf8"));
  const originalPath = ownedProvenance.localLoaderSource?.file;
  if (typeof originalPath !== "string" || !/^vendor\/qemu\/owned-[a-zA-Z0-9._-]+\/qemu-system-x86_64\.worker\.original\.js$/.test(originalPath))
    throw new Error("An owned pthread source must identify its retained local vendor file.");
  const ownedOriginal = await readFile(new URL("../" + originalPath, import.meta.url));
  const ownedDerived = Buffer.from(transformOwnedQemuPthread(ownedOriginal));
  if (ownedProvenance.runtimeCompatibility !== ownedBundle.id
    || ownedProvenance.localLoaderSource.sha256 !== OWNED_PTHREAD_SHA256
    || ownedProvenance.localLoaderSource.transformId !== OWNED_PTHREAD_TRANSFORM_ID
    || ownedDerived.length !== ownedBundle.pthread.bytes
    || createHash("sha256").update(ownedDerived).digest("hex") !== ownedBundle.pthread.sha256)
    throw new Error("The measured owned pthread source, deterministic derivation and catalog disagree.");
  await writeFile(new URL(ownedBundle.pthread.file, directory), ownedDerived);
}
const pinned = [
  loaderRecord,
  { file: "alpine-packages.json", bytes: 1163122, sha256: "a8785aa9e14b50cfb9e95ae43cca7d992e635c52fbeae2cfbea5bfabf33a3ec0" },
];
for (const asset of pinned) {
  const bytes = await readFile(new URL(asset.file, directory));
  if (bytes.length !== asset.bytes || createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
    throw new Error(`QEMU integration integrity check failed: ${asset.file}. Restore the pinned upstream loader/data index; do not silently repin it.`);
}
const manifest = JSON.parse(await readFile(new URL("alpine-packages.json", directory), "utf8"));
if (manifest.schema !== "terrarium.qemu-packages/v1" ||
    manifest.source.commit !== "b7c549b5e6f4c376f76483a03e983214421434ad" ||
    provenance.upstreamArtifactCommit !== manifest.source.commit)
  throw new Error("The QEMU package index and provenance must identify the pinned upstream artifact commit.");
for (const [name, pack] of Object.entries(manifest.packages)) {
  const asset = provenance.downloadedAssets[name];
  if (!asset || asset.bytes !== pack.bytes || asset.sha256 !== pack.sha256)
    throw new Error(`QEMU ${name} package provenance does not match its data index.`);
}
for (const id of Object.keys(QEMU_BUNDLES)) {
  const bundle = getQemuBundle(id);
  for (const asset of [bundle.manifest, bundle.pthread]) {
    if (!/^[a-zA-Z0-9._/-]+$/.test(asset.file) || asset.file.startsWith("/") || asset.file.split("/").includes(".."))
      throw new Error("A QEMU bundle local asset must remain within the owned runtime directory.");
    const bytes = await readFile(new URL(asset.file, directory));
    if (bytes.length !== asset.bytes || createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
      throw new Error(`QEMU catalog local asset differs from its measured pin: ${id} / ${asset.file}`);
  }
  assertQemuBundleManifest(JSON.parse(await readFile(new URL(bundle.manifest.file, directory), "utf8")), bundle);
  for (const asset of Object.values(bundle.assets)) {
    if (asset.url.startsWith("https://")) continue;
    if (!asset.url.startsWith("runtime/qemu/") || !/^[a-zA-Z0-9._/-]+$/.test(asset.url) || asset.url.split("/").includes(".."))
      throw new Error("An owned QEMU artifact must remain beneath its application runtime directory.");
    const bytes = await readFile(new URL(asset.url.slice("runtime/qemu/".length), directory));
    if (bytes.length !== asset.bytes || createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
      throw new Error(`Owned QEMU artifact differs from its identified build output: ${id} / ${asset.url}`);
  }
}
for (const filename of [
  "worker.js", "dispatch.js", "catalog.js", "bundles.js", "options.js", "engine.js", "channels.js", "monitor.js", "initramfs.js",
  "serial.js", "block.js", "checkpoint.js", "machine-config.js", "machine-image.js", "custom-image.js", "sha256.js",
  "Emscripten-LICENSE.txt", "QEMU-LICENSE.txt", "QEMU-COPYING.txt", "provenance.json",
]) await access(new URL(filename, directory));
for (const filename of await readdir(directory)) {
  if (/\.(wasm|data|bin|img|raw)$/.test(filename) || filename === "out.js")
    throw new Error(`Remove upstream executable/guest asset public/runtime/qemu/${filename} before building. These bytes are verified downloads on Boot, not bundled application assets.`);
}
console.log(`Verified the legacy upstream pins and ${ownedBundles.length} owned runtime bundle(s), including their bounded MIT pthread adaptations. Runtime/guest bytes match their measured catalog pins; execution and reproducibility require separate qualification.`);
