export type MachineImageComponentKind = "kernel" | "initramfs" | "rootfs";
export interface MachineImageComponent { readonly bytes: number; readonly sha256: string }
export interface MachineImageManifest {
  readonly schema: "terrarium.machine-image/v1";
  readonly architecture: "x86_64";
  readonly integration: "terrarium-qemu-uart4-v1";
  readonly guest: { readonly name: string; readonly version: string; readonly kernelRelease: string; readonly identity: string };
  readonly devices: { readonly machine: "pc"; readonly root: "virtio-blk-pci"; readonly network: "virtio-net-pci"; readonly serialPorts: 4 };
  readonly boot: { readonly initramfs: "alpine-overlay-v1"; readonly rootFilesystem: "ext4"; readonly rootMode: "ephemeral-overlay"; readonly hostname: string };
  readonly components: Readonly<Record<MachineImageComponentKind, MachineImageComponent>>;
  readonly provenance: { readonly source: string; readonly recipe: string; readonly recipeSha256: string; readonly sourceDateEpoch: number;
    readonly inputs: readonly { readonly name: string; readonly bytes: number; readonly sha256: string }[] };
}
export const MACHINE_IMAGE_SCHEMA: "terrarium.machine-image/v1";
export const MACHINE_IMAGE_MAGIC: "TRMIMG01";
export const MACHINE_IMAGE_LIMITS: Readonly<{ manifestBytes: number; kernelBytes: number; initramfsBytes: number; rootfsBytes: number; chunkBytes: number; provenanceInputs: number }>;
export const MACHINE_IMAGE_MAX_BYTES: number;
export function validateMachineImageManifest(value: unknown): MachineImageManifest;
export function canonicalMachineImageManifest(value: unknown): string;
export function assertMachineImageComponentHeader(kind: MachineImageComponentKind, bytes: Uint8Array<ArrayBuffer>, totalBytes: number): void;
