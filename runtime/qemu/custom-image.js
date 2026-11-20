// SPDX-License-Identifier: Apache-2.0
import { Sha256Stream } from "./sha256.js";
import { assertMachineImageComponentHeader, canonicalMachineImageManifest, validateMachineImageManifest } from "./machine-image.js";

function rawRecord(value) {
  const keys = ["id", "manifest", "kernel", "initramfs", "rootfs"];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("Custom image must be a plain data record.");
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== "string" || !keys.includes(key)))
    throw new Error("Custom image has missing or unsupported fields.");
  for (const key of own) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error("Custom image cannot contain accessors.");
  }
  return value;
}

function hash(bytes) {
  const digest = new Sha256Stream();
  for (let offset = 0; offset < bytes.byteLength; offset += 65_536) digest.update(bytes.subarray(offset, offset + 65_536));
  return digest.digestHex();
}

/** Independently verify the worker boundary before loading any runtime module. */
export function validateRawMachineImage(value) {
  const data = rawRecord(value);
  if (typeof data.id !== "string" || !/^[a-f0-9]{64}$/.test(data.id)) throw new Error("Custom image identity must be a SHA-256 digest.");
  const manifest = validateMachineImageManifest(data.manifest);
  const canonical = new TextEncoder().encode(canonicalMachineImageManifest(manifest));
  if (hash(canonical) !== data.id) throw new Error("Custom image manifest identity does not match its bytes.");
  for (const key of ["kernel", "initramfs", "rootfs"]) {
    const bytes = data[key];
    if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) || bytes.byteLength !== manifest.components[key].bytes)
      throw new Error(`Custom image ${key} must contain the exact bounded, non-shared bytes.`);
    assertMachineImageComponentHeader(key, bytes.subarray(0, 2048), bytes.byteLength);
    if (hash(bytes) !== manifest.components[key].sha256) throw new Error(`Custom image ${key} SHA-256 mismatch.`);
  }
  return Object.freeze({ id: data.id, manifest, kernel: data.kernel, initramfs: data.initramfs, rootfs: data.rootfs });
}
