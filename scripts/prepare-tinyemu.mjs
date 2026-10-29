// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";

const directory = new URL("../public/runtime/tinyemu/", import.meta.url);
const assets = [
  {
    file: "riscvemu64-wasm.js",
    bytes: 65_788,
    sha256: "1637ea50d0a5b4cb138eac6a02d8654c696e5315b7d5c1c78b63e8e2b29fd601",
  },
  {
    file: "riscvemu64-wasm.wasm",
    bytes: 220_054,
    sha256: "4e4d5d60713bab852a1e95b673fbb26d805010b8acbffce9a860e4f3fb88196b",
  },
];
for (const asset of assets) {
  const bytes = await readFile(new URL(asset.file, directory));
  if (
    bytes.length !== asset.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== asset.sha256
  ) {
    throw new Error(
      `TinyEMU integrity check failed: ${asset.file}. Restore the exact 2019-12-21 release; do not silently repin its hash.`,
    );
  }
}
for (const filename of [
  "MIT-LICENSE.txt",
  "THIRD_PARTY_NOTICES.txt",
  "provenance.json",
  "worker.js",
  "filesystem.js",
  "guest-profiles.json",
])
  await access(new URL(filename, directory));
for (const filename of [
  "bbl64.bin",
  "kernel-riscv64.bin",
  "root-riscv64.bin",
  "alpine-minirootfs-3.24.3-riscv64.tar.gz",
  "rootfs.tar.gz",
]) {
  let found = false;
  try {
    await access(new URL(filename, directory));
    found = true;
  } catch {
    /* Guest files belong at their upstream origin. */
  }
  if (found)
    throw new Error(
      `Remove guest binary public/runtime/tinyemu/${filename} before building. Guest binaries are fetched by users, not redistributed.`,
    );
}
console.log(
  "Verified 2 MIT TinyEMU assets and notices. RISC-V guest binaries remain upstream.",
);
