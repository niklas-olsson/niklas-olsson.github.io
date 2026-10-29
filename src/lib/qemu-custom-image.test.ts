// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { validateRawMachineImage } from "../../public/runtime/qemu/custom-image.js";
import { canonicalMachineImageManifest, type MachineImageManifest } from "../../public/runtime/qemu/machine-image.js";
import { startQemu } from "../../public/runtime/qemu/engine.js";

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** Structural unit fixture only. These bytes are deliberately not a runnable guest. */
function fixture() {
  const kernel = new Uint8Array(4096), initramfs = new Uint8Array(18), rootfs = new Uint8Array(4 * 1024 * 1024);
  const kernelHeader = new DataView(kernel.buffer), rootHeader = new DataView(rootfs.buffer);
  kernel[0x1f1] = 1;
  kernelHeader.setUint32(0x1f4, 2, true);
  kernelHeader.setUint16(0x1fe, 0xaa55, true);
  kernelHeader.setUint32(0x202, 0x53726448, true);
  kernelHeader.setUint16(0x206, 0x20c, true);
  kernelHeader.setUint16(0x236, 1, true);
  initramfs.set([0x1f, 0x8b, 8]);
  rootHeader.setUint32(1024 + 0x4, rootfs.length / 4096, true);
  rootHeader.setUint32(1024 + 0x18, 2, true);
  rootHeader.setUint16(1024 + 0x38, 0xef53, true);
  rootHeader.setUint16(1024 + 0x3a, 1, true);
  rootHeader.setUint32(1024 + 0x4c, 1, true);
  rootHeader.setUint16(1024 + 0x58, 256, true);
  rootHeader.setUint32(1024 + 0x60, 0x40, true);
  const manifest: MachineImageManifest = {
    schema: "terrarium.machine-image/v1", architecture: "x86_64", integration: "terrarium-qemu-uart4-v1",
    guest: { name: "Unit fixture", version: "1", kernelRelease: "fixture", identity: "non-runnable-unit-fixture" },
    devices: { machine: "pc", root: "virtio-blk-pci", network: "virtio-net-pci", serialPorts: 4 },
    boot: { initramfs: "alpine-overlay-v1", rootFilesystem: "ext4", rootMode: "ephemeral-overlay", hostname: "fixture" },
    components: {
      kernel: { bytes: kernel.length, sha256: digest(kernel) },
      initramfs: { bytes: initramfs.length, sha256: digest(initramfs) },
      rootfs: { bytes: rootfs.length, sha256: digest(rootfs) },
    },
    provenance: { source: "Unit fixture, not a Linux execution", recipe: "qemu-custom-image-test", recipeSha256: "a".repeat(64), sourceDateEpoch: 0,
      inputs: [{ name: "synthetic", bytes: 1, sha256: "b".repeat(64) }] },
  };
  return { id: digest(canonicalMachineImageManifest(manifest)), manifest, kernel, initramfs, rootfs };
}

test("raw worker image boundary independently verifies manifest and component identities", () => {
  const image = fixture();
  const checked = validateRawMachineImage(image);
  assert.equal(checked.id, image.id);
  assert.equal(checked.rootfs, image.rootfs, "Verification must not allocate a second whole raw root.");
  assert.ok(Object.isFrozen(checked.manifest));
  image.rootfs[4095] = 1;
  assert.throws(() => validateRawMachineImage(image), /rootfs SHA-256 mismatch/);
});

test("worker image boundary rejects executable fields, accessors, shared bytes, and missing data", () => {
  const image = fixture();
  assert.throws(() => validateRawMachineImage({ ...image, arguments: ["-netdev", "user"] }), /unsupported fields/);
  let reads = 0;
  assert.throws(() => validateRawMachineImage({ ...image, get rootfs() { reads++; return image.rootfs; } }), /accessors/);
  assert.equal(reads, 0);
  assert.throws(() => validateRawMachineImage({ ...image, rootfs: new Uint8Array(new SharedArrayBuffer(image.rootfs.length)) }), /non-shared/);
  assert.throws(() => validateRawMachineImage({ ...image, kernel: image.kernel.subarray(1) }), /exact bounded/);
  assert.throws(() => validateRawMachineImage({ ...image, id: "0".repeat(64) }), /manifest identity/);
});

test("tampered custom image fails before any executable module is loaded", async () => {
  const image = fixture(); image.kernel[0x202] = 0;
  let loaded = 0;
  await assert.rejects(startQemu({ customImage: image }, {
    emit() {}, pthreadUrl: "https://example.invalid/pthread.js",
    async loadModule() { loaded++; throw new Error("Executable module must not load."); },
  }), /Linux x86_64 bzImage/);
  assert.equal(loaded, 0);
});
