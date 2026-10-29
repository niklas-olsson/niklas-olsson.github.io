import type { MachineImageManifest } from "./machine-image.js";
export interface RawMachineImage {
  readonly id: string;
  readonly manifest: MachineImageManifest;
  readonly kernel: Uint8Array<ArrayBuffer>;
  readonly initramfs: Uint8Array<ArrayBuffer>;
  readonly rootfs: Uint8Array<ArrayBuffer>;
}
export function validateRawMachineImage(value: unknown): RawMachineImage;
