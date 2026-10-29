// SPDX-License-Identifier: Apache-2.0
// Extract data indexes from the pinned upstream loaders without executing them.
// Download the four load-*.js and load-*.data pairs from:
// https://github.com/ktock/qemu-wasm-demo-images/tree/b7c549b5e6f4c376f76483a03e983214421434ad/alpine-x86_64
// Run: node scripts/extract-qemu-packages.mjs /path/to/pinned/assets [output.json]
// This is a maintainer regeneration tool, not a build-time download step.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const arguments_ = process.argv.slice(2);
if (arguments_.length < 1 || arguments_.length > 2) {
  throw new Error("Usage: node scripts/extract-qemu-packages.mjs <local-pinned-asset-directory> [output.json]");
}
const [sourceDirectory, destination = new URL("../public/runtime/qemu/alpine-packages.json", import.meta.url)] = arguments_;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const rootBytes = 157286400;
const chunkBytes = 2048;
// LZ4 can report a successful compressed block that is slightly larger than
// its input. The upstream encoder retains those blocks in this exact package.
const compressedChunkBound = chunkBytes + Math.floor(chunkBytes / 255) + 16;
const expected = {
  kernel: {
    bytes: 11666432,
    sha256: "dd239e40daf62dfb34e1bedb281ee66a98ae9664935d0471c026726629a52c25",
    loaderSha256: "7eeff850d00dd148bef92f171108bfb81162999d3f0f840e8d87af924e4f1792",
    files: [{ filename: "/pack-kernel/vmlinuz-virt", start: 0, end: 11666432 }],
  },
  initramfs: {
    bytes: 9699151,
    sha256: "84fd4d99c66dc78302428ea381c14252aad2c604fc16021d19c7dd12679fc09c",
    loaderSha256: "28274428aebf8c8e4950a64ddb6aca326dd68418f50913019af5edffdc1001da",
    files: [{ filename: "/pack-initramfs/initramfs-virt", start: 0, end: 9699151 }],
  },
  rom: {
    bytes: 473088,
    sha256: "15de099e1363ceb13a31b9d11836337bab974f9460836449330b20c0534d06c9",
    loaderSha256: "617e4dc685cb2cedada4844f097eb18a56cf0f8bbd4c4e2e9231b4f07d0d8a88",
    files: [
      { filename: "/pack-rom/bios-256k.bin", start: 0, end: 262144 },
      { filename: "/pack-rom/efi-virtio.rom", start: 262144, end: 422912 },
      { filename: "/pack-rom/kvmvapic.bin", start: 422912, end: 432128 },
      { filename: "/pack-rom/linuxboot_dma.bin", start: 432128, end: 433664 },
      { filename: "/pack-rom/vgabios-stdvga.bin", start: 433664, end: 473088 },
    ],
  },
  rootfs: {
    bytes: 82611515,
    sha256: "e2facfffb787471a8784863fd8bf77dd87f098809a9b5cd54d9f082929596b3a",
    loaderSha256: "9e8a19991b404d4759b1a15093ba5555a6a13dcf60323871c6e2ddde295dc648",
    files: [{ filename: "/pack-rootfs/disk-rootfs.img", start: 0, end: rootBytes }],
  },
};

function singleJson(source, expression, label) {
  const matches = [...source.matchAll(expression)];
  assert.equal(matches.length, 1, `${label}: expected exactly one JSON data declaration`);
  return JSON.parse(matches[0][1]);
}

function validateCompressedIndex(index, packageBytes) {
  assert.deepEqual(Object.keys(index), ["data", "cachedOffset", "cachedIndexes", "cachedChunks", "offsets", "sizes", "successes"]);
  assert.equal(index.data, null);
  assert.deepEqual(index.cachedIndexes, [-1, -1]);
  assert.deepEqual(index.cachedChunks, [null, null]);
  const chunks = rootBytes / chunkBytes;
  for (const key of ["offsets", "sizes", "successes"]) {
    assert.ok(Array.isArray(index[key]), `rootfs ${key}: expected an array`);
    assert.equal(index[key].length, chunks, `rootfs ${key}: expected ${chunks} chunks`);
  }
  let offset = 0;
  for (let i = 0; i < chunks; i++) {
    assert.equal(index.offsets[i], offset, `rootfs chunk ${i}: noncontiguous offset`);
    const size = index.sizes[i];
    const compressed = index.successes[i];
    assert.ok(Number.isSafeInteger(size) && size >= 1 && size <= compressedChunkBound, `rootfs chunk ${i}: invalid length`);
    assert.ok(compressed === 0 || compressed === 1, `rootfs chunk ${i}: invalid compression flag`);
    if (compressed === 0) assert.equal(size, chunkBytes, `rootfs chunk ${i}: uncompressed length`);
    offset += size;
  }
  assert.equal(index.cachedOffset, offset, "rootfs cache must follow the compressed chunks");
  assert.equal(offset + 2 * chunkBytes, packageBytes, "rootfs package must contain two cache chunks");
}

const packages = {};
for (const [name, pin] of Object.entries(expected)) {
  const loaderName = `load-${name}.js`;
  const dataName = `load-${name}.data`;
  const loaderBytes = await readFile(join(sourceDirectory, loaderName));
  assert.equal(hash(loaderBytes), pin.loaderSha256, `${loaderName}: pinned SHA-256 mismatch`);
  const data = await readFile(join(sourceDirectory, dataName));
  assert.equal(data.length, pin.bytes, `${dataName}: pinned byte length mismatch`);
  assert.equal(hash(data), pin.sha256, `${dataName}: pinned SHA-256 mismatch`);
  const loader = loaderBytes.toString("utf8");
  const metadata = singleJson(loader, /loadPackage\((\{"files".*?\})\);/gs, loaderName);
  assert.deepEqual(metadata, { files: pin.files, remote_package_size: pin.bytes }, `${loaderName}: unexpected file paths or offsets`);
  const pack = {
    file: dataName,
    bytes: pin.bytes,
    sha256: pin.sha256,
    loaderSha256: pin.loaderSha256,
    metadata,
  };
  if (name === "rootfs") {
    const compressedData = singleJson(loader, /var compressedData = (\{.*?\})\s*;/gs, loaderName);
    validateCompressedIndex(compressedData, data.length);
    delete compressedData.data;
    pack.compressedData = compressedData;
  }
  packages[name] = pack;
}

const manifest = {
  schema: "terrarium.qemu-packages/v1",
  source: {
    repository: "https://github.com/ktock/qemu-wasm-demo-images",
    commit: "b7c549b5e6f4c376f76483a03e983214421434ad",
  },
  guest: { architecture: "x86_64", distribution: "Alpine Linux 3.21.4", kernel: "6.12.43-0-virt", rootBytes },
  packages,
};
const output = JSON.stringify(manifest) + "\n";
assert.equal(Buffer.byteLength(output), 1163122, "Regenerated package index byte length changed");
assert.equal(hash(output), "a8785aa9e14b50cfb9e95ae43cca7d992e635c52fbeae2cfbea5bfabf33a3ec0", "Regenerated package index differs from the pinned index");
await writeFile(destination, output);
console.log("Extracted and verified the pinned data-only QEMU package index (1,163,122 bytes). No loader code was executed.");
