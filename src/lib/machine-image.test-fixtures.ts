// SPDX-License-Identifier: Apache-2.0
// Synthetic binary fixtures exercise the parser only. They are not bootable guests.
import { createHash } from "node:crypto";
import { canonicalMachineImageManifest, createMachineImageBundle, type MachineImageManifest } from "./machine-image.ts";

export function fixtureComponents(): Record<"kernel" | "initramfs" | "rootfs", Uint8Array<ArrayBuffer>> {
  const kernel = new Uint8Array(4096);
  const kv = new DataView(kernel.buffer);
  kv.setUint16(0x1fe, 0xaa55, true); kv.setUint32(0x202, 0x53726448, true);
  kv.setUint16(0x206, 0x20f, true); kv.setUint16(0x236, 1, true); kv.setUint32(0x1f4, 16, true);
  const initramfs = new Uint8Array(32); initramfs.set([0x1f, 0x8b, 8, 0]);
  const rootfs = new Uint8Array(4 * 1024 * 1024);
  const rv = new DataView(rootfs.buffer); const at = 1024;
  rv.setUint16(at + 0x38, 0xef53, true); rv.setUint32(at + 0x18, 2, true);
  rv.setUint32(at + 0x4c, 1, true); rv.setUint16(at + 0x58, 256, true);
  rv.setUint32(at + 0x4, rootfs.length / 4096, true); rv.setUint16(at + 0x3a, 1, true);
  rv.setUint32(at + 0x5c, 0x38, true); rv.setUint32(at + 0x60, 0x2c2, true); rv.setUint32(at + 0x64, 0x46b, true);
  return { kernel, initramfs, rootfs };
}

export function fixtureManifest(components = fixtureComponents(), identity = "synthetic-parser-fixture"): MachineImageManifest {
  const describe = (bytes: Uint8Array) => ({ bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
  return {
    schema: "terrarium.machine-image/v1", architecture: "x86_64", integration: "terrarium-qemu-uart4-v1",
    guest: { name: "Parser fixture (not bootable)", version: "fixture-1", kernelRelease: "6.12.38-0-virt", identity },
    devices: { machine: "pc", root: "virtio-blk-pci", network: "virtio-net-pci", serialPorts: 4 },
    boot: { initramfs: "alpine-overlay-v1", rootFilesystem: "ext4", rootMode: "ephemeral-overlay", hostname: "parser-fixture" },
    components: { kernel: describe(components.kernel), initramfs: describe(components.initramfs), rootfs: describe(components.rootfs) },
    provenance: { source: "Synthetic unit fixture; never a boot qualification", recipe: "unit-fixture-v1", recipeSha256: "1".repeat(64),
      sourceDateEpoch: 1700000000, inputs: [{ name: "synthetic-zero-bytes", bytes: components.rootfs.length, sha256: describe(components.rootfs).sha256 }] },
  };
}

export async function fixtureImage(identity?: string) {
  const components = fixtureComponents();
  const manifest = fixtureManifest(components, identity);
  return createMachineImageBundle(manifest, { kernel: new Blob([components.kernel]), initramfs: new Blob([components.initramfs]), rootfs: new Blob([components.rootfs]) });
}

export function uncheckedFixtureBundle(manifest: unknown, components = fixtureComponents(), encoded?: string): Blob {
  const json = new TextEncoder().encode(encoded ?? canonicalMachineImageManifest(manifest));
  const header = new Uint8Array(12); header.set(new TextEncoder().encode("TRMIMG01")); new DataView(header.buffer).setUint32(8, json.length, true);
  return new Blob([header, json, components.kernel, components.initramfs, components.rootfs]);
}
