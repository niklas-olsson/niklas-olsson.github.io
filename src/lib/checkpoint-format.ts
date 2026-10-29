// SPDX-License-Identifier: Apache-2.0
import { MAX_SNAPSHOT_BYTES, RUNTIME_VERSION } from "./runtime-types.ts";
import { inspectSnapshot, validateSnapshot } from "./snapshot-format.ts";
import { sha256Bytes } from "./evidence.ts";
import {
  MAX_QEMU_CHECKPOINT_BYTES, isQemuCheckpoint,
  parseQemuCheckpoint, inspectQemuRegisters, type CheckpointCpu,
} from "./qemu-checkpoint.ts";
import type { RuntimeProfileId } from "./runtime-profiles.ts";
import { DEFAULT_QEMU_BUNDLE_ID, getQemuBundle, isSupportedQemuBundleId } from "./qemu-assets.ts";
import { defaultX86MachineConfiguration, qemuPresetBootOptions, type X86MachineConfiguration } from "./x86-machine-config.ts";

/** Initial upload bound. Each decoder applies its own tighter format limit. */
export const MAX_CHECKPOINT_BYTES = Math.max(MAX_SNAPSHOT_BYTES, MAX_QEMU_CHECKPOINT_BYTES);
export type CheckpointKind = "v86-checkpoint" | "qemu-checkpoint";
export type CheckpointProfile = "x86" | "alpine-x86_64";
export interface CheckpointInspection {
  machine?: X86MachineConfiguration;
  kind: CheckpointKind;
  profileId: CheckpointProfile;
  sha256: string;
  size: number;
  formatVersion: number;
  runtimeVersion: string;
  memoryMiB: number;
  videoMemoryMiB: number | null;
  serialPorts: number;
  metadataBytes: number;
  bufferCount: number | null;
  cpuSource: "serialized-state" | "captured-monitor" | "unavailable";
  cpu: CheckpointCpu;
}

export function checkpointRuntimeVersion(profileId: RuntimeProfileId): string | null {
  if (profileId === "x86") return RUNTIME_VERSION;
  if (profileId === "alpine-x86_64") return DEFAULT_QEMU_BUNDLE_ID;
  return null;
}

/** UI eligibility only; restore still validates the complete checkpoint bytes. */
export function isCheckpointRuntimeCompatible(profileId: RuntimeProfileId, runtimeVersion: unknown): boolean {
  if (profileId === "x86") return runtimeVersion === RUNTIME_VERSION;
  if (profileId !== "alpine-x86_64" || !isSupportedQemuBundleId(runtimeVersion) || getQemuBundle(runtimeVersion).profileId !== profileId) return false;
  try { return qemuPresetBootOptions(defaultX86MachineConfiguration({ runtimeBundleId: runtimeVersion, mac: "02:00:00:00:00:01" })).checkpointSupported; }
  catch { return false; }
}

/** Structural, compatibility and integrity validation without starting a guest. */
export async function inspectCheckpoint(input: ArrayBuffer): Promise<CheckpointInspection> {
  if (!(input instanceof ArrayBuffer) || input.byteLength < 64 || input.byteLength > MAX_CHECKPOINT_BYTES)
    throw new Error("Choose a complete Terrarium checkpoint within its runtime's supported size.");
  if (isQemuCheckpoint(input)) {
    const checkpoint = await parseQemuCheckpoint(input);
    const { manifest, buffer } = checkpoint;
    return Object.freeze({
      kind: "qemu-checkpoint", profileId: manifest.profileId,
      sha256: await sha256Bytes(buffer), size: buffer.byteLength, formatVersion: manifest.version,
      runtimeVersion: manifest.runtimeVersion, memoryMiB: manifest.memoryMiB, videoMemoryMiB: null,
      machine: manifest.machine ?? defaultX86MachineConfiguration({ runtimeBundleId: manifest.runtimeVersion, mac: manifest.mac }),
      serialPorts: manifest.serialPorts, metadataBytes: new DataView(buffer).getUint32(12, true), bufferCount: null,
      cpuSource: manifest.registers ? "captured-monitor" : "unavailable",
      cpu: Object.freeze(inspectQemuRegisters(manifest.registers)),
    });
  }
  const observed = await inspectSnapshot(input);
  return Object.freeze({ ...observed, kind: "v86-checkpoint", profileId: "x86", cpuSource: "serialized-state" });
}

/** Reject a foreign checkpoint before its target runtime stops or downloads anything. */
export async function assertCheckpointProfile(input: ArrayBuffer, profileId: RuntimeProfileId): Promise<void> {
  if (isQemuCheckpoint(input)) {
    if (profileId !== "alpine-x86_64") throw new Error("This checkpoint belongs to Alpine x86_64. Select an x86_64 machine or create a quarantined clone.");
    await parseQemuCheckpoint(input);
    return;
  }
  validateSnapshot(input);
  if (profileId !== "x86") throw new Error("This checkpoint belongs to the 32-bit Pocket PC profile. Select a compatible machine or create a quarantined clone.");
}
