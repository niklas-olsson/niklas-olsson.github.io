// SPDX-License-Identifier: Apache-2.0
// Populate a verification-only cache of the currently declared QEMU artifacts.
// This downloads existing pinned bytes. It does not build or attest their source.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { DEFAULT_QEMU_BUNDLE_ID } from "../public/runtime/qemu/catalog.js";
import { getQemuBundle } from "../public/runtime/qemu/bundles.js";

const args = process.argv.slice(2);
if (args.length > 1 || args[0]?.startsWith("--")) {
  throw new Error("Usage: node scripts/cache-qemu-assets.mjs [cache-directory]");
}
const targetDirectory = resolve(args[0] ?? process.env.TERRARIUM_QEMU_ASSET_DIR ?? ".cache/qemu");
const bundle = getQemuBundle(process.env.TERRARIUM_QEMU_BUNDLE_ID ?? DEFAULT_QEMU_BUNDLE_ID);
const publicDirectory = new URL("../public/", import.meta.url);
await mkdir(targetDirectory, { recursive: true });

async function digestFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

const observations = [];
for (const [role, asset] of Object.entries(bundle.assets)) {
  const url = new URL(asset.url, publicDirectory);
  if (!["https:", "file:"].includes(url.protocol) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
    throw new Error(`Invalid pinned ${role} asset declaration.`);
  }
  if (url.protocol === "file:" && !url.href.startsWith(publicDirectory.href)) throw new Error("An owned asset must remain beneath public/.");
  const filename = basename(url.pathname);
  if (!filename || filename === "." || filename === "..") throw new Error("Invalid asset filename.");
  const path = join(targetDirectory, filename);
  const current = await stat(path).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (current?.size === asset.bytes && await digestFile(path) === asset.sha256) {
    observations.push({ role, filename, bytes: asset.bytes, sha256: asset.sha256, result: "verified-cache" });
    console.log(`Verified cached ${role}: ${filename} (${asset.bytes} bytes)`);
    continue;
  }
  const temporary = join(targetDirectory, `${filename}.${randomUUID()}.partial`);
  try {
    let input;
    if (url.protocol === "file:") input = createReadStream(fileURLToPath(url));
    else {
      const response = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(180_000) });
      if (!response.ok || !response.body) throw new Error(`Asset download returned HTTP ${response.status}: ${role}`);
      input = Readable.fromWeb(response.body);
    }
    let count = 0;
    const hash = createHash("sha256");
    const boundedHash = new Transform({
      transform(chunk, _encoding, callback) {
        count += chunk.length;
        if (count > asset.bytes) return callback(new Error(`Oversized ${role} download.`));
        hash.update(chunk); callback(null, chunk);
      },
    });
    await pipeline(input, boundedHash, createWriteStream(temporary, { flags: "wx" }));
    if (count !== asset.bytes || hash.digest("hex") !== asset.sha256) throw new Error(`Integrity check failed for ${role}.`);
    await rename(temporary, path);
    const result = url.protocol === "file:" ? "copied-and-verified" : "downloaded-and-verified";
    observations.push({ role, filename, bytes: count, sha256: asset.sha256, result });
    console.log(`Cached and verified ${role}: ${filename} (${count} bytes)`);
  } finally {
    await rm(temporary, { force: true });
  }
}
console.log(JSON.stringify({ schema: "terrarium.qemu-cache-verification/v2", runtimeBundleId: bundle.id, assets: observations }));
