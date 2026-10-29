import type { QemuBundleId } from "./catalog.js";
export type X86MachinePresetId = "small" | "worker" | "server";
export interface X86MachineConfiguration {
  readonly schema: "terrarium.x86-machine/v1";
  readonly presetId: X86MachinePresetId;
  readonly runtimeBundleId: QemuBundleId;
  readonly image: Readonly<{ kind: "builtin" | "custom"; id: string }>;
  readonly nic: Readonly<{ mac: string }>;
  readonly consoles: readonly [0, 1, 2, 3];
  readonly diskSlots: readonly Readonly<{ slot: 0 | 1; serial: string }>[];
  readonly diskPolicy: "persistent-mounts";
  readonly kernelSettings: Readonly<{ hostname?: string }>;
}
export interface X86MachinePreset { readonly id: X86MachinePresetId; readonly label: string; readonly memoryMiB: number; readonly virtualCpus: number; readonly minimumWasmMiB: number; readonly memoryLayout: "single-ram-block-v1" | "split-2x1024m-ram-blocks-v1"; readonly checkpointSupported: boolean }
export const X86_MACHINE_SCHEMA: X86MachineConfiguration["schema"];
export const X86_MACHINE_PRESETS: Readonly<Record<X86MachinePresetId, X86MachinePreset>>;
export function validMachineMac(value: unknown): value is string;
export function validateX86MachineConfiguration(value: unknown): X86MachineConfiguration;
export function defaultX86MachineConfiguration(options?: { runtimeBundleId?: QemuBundleId; mac?: string; presetId?: X86MachinePresetId; image?: X86MachineConfiguration["image"]; hostname?: string }): X86MachineConfiguration;
export function qemuPresetBootOptions(value: X86MachineConfiguration): Readonly<{ memoryMiB: number; virtualCpus: number; memoryLayout: X86MachinePreset["memoryLayout"]; kernelAppend: string; checkpointSupported: boolean; reservedWasmMiB: number; translationCacheMiB: number }>;
export function machineCheckpointIdentity(value: X86MachineConfiguration): X86MachineConfiguration;
