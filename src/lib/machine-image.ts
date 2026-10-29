// SPDX-License-Identifier: Apache-2.0
import {
  assertMachineImageComponentHeader,
  canonicalMachineImageManifest,
  MACHINE_IMAGE_LIMITS,
  MACHINE_IMAGE_MAGIC,
  MACHINE_IMAGE_MAX_BYTES,
  validateMachineImageManifest,
  type MachineImageComponentKind,
  type MachineImageManifest,
} from "../../public/runtime/qemu/machine-image.js";
import { Sha256Stream } from "./sha256-stream.ts";

export { assertMachineImageComponentHeader, canonicalMachineImageManifest, MACHINE_IMAGE_LIMITS,
  MACHINE_IMAGE_MAGIC, MACHINE_IMAGE_MAX_BYTES, validateMachineImageManifest };
export type { MachineImageComponentKind, MachineImageManifest };
export const MACHINE_IMAGE_MIME = "application/vnd.terrarium.machine-image";
const KINDS: readonly MachineImageComponentKind[] = ["kernel", "initramfs", "rootfs"];

export interface MachineImageValidationOptions { readonly signal?: AbortSignal }
export interface ValidatedMachineImage {
  readonly id: string;
  readonly manifest: MachineImageManifest;
  readonly blob: Blob;
  readonly components: Readonly<Record<MachineImageComponentKind, Blob>>;
  readonly totalBytes: number;
}

function abort(signal?: AbortSignal): void { signal?.throwIfAborted(); }

/** Parses and hashes bounded immutable Blob slices. Never allocates the logical disk/container as one array. */
export async function inspectMachineImage(blob: Blob, options: MachineImageValidationOptions = {}): Promise<ValidatedMachineImage> {
  const { signal } = options;
  abort(signal);
  if (!(blob instanceof Blob) || blob.size < 12 || blob.size > MACHINE_IMAGE_MAX_BYTES)
    throw new Error("Choose a Terrarium image bundle within the 64 MiB kernel, 64 MiB initramfs and 512 MiB root budgets.");
  const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  abort(signal);
  if (new TextDecoder().decode(header.subarray(0, 8)) !== MACHINE_IMAGE_MAGIC)
    throw new Error("This is not a TRMIMG01 data-only machine image bundle.");
  const manifestBytes = new DataView(header.buffer).getUint32(8, true);
  if (manifestBytes < 2 || manifestBytes > MACHINE_IMAGE_LIMITS.manifestBytes || 12 + manifestBytes > blob.size)
    throw new Error("The image manifest length is invalid or exceeds 64 KiB.");
  const encoded = new Uint8Array(await blob.slice(12, 12 + manifestBytes).arrayBuffer());
  abort(signal);
  let manifest: MachineImageManifest;
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
    manifest = validateMachineImageManifest(JSON.parse(json));
    if (canonicalMachineImageManifest(manifest) !== json) throw new Error("Manifest JSON must use the canonical encoding; duplicate keys are not allowed.");
  } catch (error) {
    throw new Error(`The image manifest was rejected: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
  const expectedBytes = 12 + manifestBytes + KINDS.reduce((size, kind) => size + manifest.components[kind].bytes, 0);
  if (blob.size !== expectedBytes) throw new Error("Image payload lengths do not match the manifest; trailing or truncated data is not accepted.");
  // The canonical manifest binds every component digest/size. The worker can
  // verify this identity without joining large component arrays into a container.
  const id = new Sha256Stream().update(encoded).digestHex();
  const components = {} as Record<MachineImageComponentKind, Blob>;
  let offset = 12 + manifestBytes;
  for (const kind of KINDS) {
    abort(signal);
    const descriptor = manifest.components[kind];
    const component = blob.slice(offset, offset + descriptor.bytes, "application/octet-stream");
    const prefix = new Uint8Array(await component.slice(0, Math.min(2048, component.size)).arrayBuffer());
    abort(signal);
    assertMachineImageComponentHeader(kind, prefix, component.size);
    const hash = new Sha256Stream();
    for (let position = 0; position < component.size; position += MACHINE_IMAGE_LIMITS.chunkBytes) {
      abort(signal);
      const chunk = new Uint8Array(await component.slice(position, position + MACHINE_IMAGE_LIMITS.chunkBytes).arrayBuffer());
      abort(signal);
      hash.update(chunk);
    }
    if (hash.digestHex() !== descriptor.sha256) throw new Error(`The ${kind} SHA-256 digest does not match; no saved machine has been changed.`);
    components[kind] = component;
    offset += descriptor.bytes;
  }
  abort(signal);
  return Object.freeze({ id, manifest, blob, components: Object.freeze(components), totalBytes: blob.size });
}

/** A Blob concatenation keeps export bounded; inspect verifies every byte before returning it. */
export async function createMachineImageBundle(manifest: unknown, components: Readonly<Record<MachineImageComponentKind, Blob>>,
  options: MachineImageValidationOptions = {}): Promise<ValidatedMachineImage> {
  const validated = validateMachineImageManifest(manifest);
  const json = new TextEncoder().encode(canonicalMachineImageManifest(validated));
  if (json.byteLength > MACHINE_IMAGE_LIMITS.manifestBytes) throw new Error("Image manifest exceeds its 64 KiB budget.");
  for (const kind of KINDS) {
    if (!(components[kind] instanceof Blob) || components[kind].size !== validated.components[kind].bytes)
      throw new Error(`${kind} bytes do not match the image manifest.`);
  }
  const header = new Uint8Array(12);
  header.set(new TextEncoder().encode(MACHINE_IMAGE_MAGIC));
  new DataView(header.buffer).setUint32(8, json.byteLength, true);
  return inspectMachineImage(new Blob([header, json, ...KINDS.map((kind) => components[kind])], { type: MACHINE_IMAGE_MIME }), options);
}
