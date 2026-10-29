export const LEGACY_QEMU_BUNDLE_ID: "qemu@8.2.0-b7c549b5-uart4-v1";
export const OWNED_QEMU_V2_BUNDLE_ID: "qemu@8.2.0-terrarium-0ef7b4e-s1-candidate-v2";
export const OWNED_QEMU_BUNDLE_ID: "qemu@8.2.0-terrarium-0ef7b4e-s1-candidate-v3";
export const SERVER_QEMU_V1_BUNDLE_ID: "qemu@8.2.0-terrarium-0ef7b4e-s2-server-v1";
export const SERVER_QEMU_V2_BUNDLE_ID: "qemu@8.2.0-terrarium-0ef7b4e-s2-server-v2";
export const SERVER_QEMU_BUNDLE_ID: "qemu@8.2.0-terrarium-0ef7b4e-s2-server-v3";
export const DEFAULT_QEMU_BUNDLE_ID: typeof LEGACY_QEMU_BUNDLE_ID;
export type QemuBundleId = typeof LEGACY_QEMU_BUNDLE_ID | typeof OWNED_QEMU_V2_BUNDLE_ID | typeof OWNED_QEMU_BUNDLE_ID | typeof SERVER_QEMU_V1_BUNDLE_ID | typeof SERVER_QEMU_V2_BUNDLE_ID | typeof SERVER_QEMU_BUNDLE_ID;
export interface QemuAsset {
  readonly name: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
}
export interface QemuLocalAsset {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}
export interface QemuRuntimeBundle {
  readonly id: QemuBundleId;
  readonly profileId: "alpine-x86_64";
  readonly architecture: "x86_64";
  readonly memoryMiB: 512 | 2048;
  readonly virtualCpus: 1 | 2;
  readonly serialPorts: 4;
  readonly integration: "terrarium-qemu-uart4-v1";
  readonly nodeAdapter: "legacy-cpu-websocket-bindings-v1" | "owned-minified-cpu-websocket-bindings-v1";
  readonly machineMemoryLayout?: "split-2x1024m-ram-blocks-v1";
  readonly guest: Readonly<{ userland: string; kernel: string; rootBytes: number }>;
  readonly resources: Readonly<{ guestMemoryMiB: number; reservedWasmMiB: number; translationCacheMiB: number }>;
  readonly assets: Readonly<Record<"module" | "wasm" | "kernel" | "initramfs" | "rom" | "rootfs", QemuAsset>>;
  readonly manifest: QemuLocalAsset;
  readonly pthread: QemuLocalAsset;
}
export const QEMU_BUNDLES: Readonly<Record<QemuBundleId, QemuRuntimeBundle>>;
