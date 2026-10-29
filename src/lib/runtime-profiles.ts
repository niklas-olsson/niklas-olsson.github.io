// SPDX-License-Identifier: Apache-2.0

import { DEFAULT_QEMU_BUNDLE_ID, getQemuBundle } from "./qemu-assets.ts";

// The catalog describes fresh boots. Restored machines separately expose their
// active runtime identity and observed guest capabilities in RuntimeSnapshot.
const qemuDefault = getQemuBundle(DEFAULT_QEMU_BUNDLE_ID);
const qemuDownloadBytes = Object.values(qemuDefault.assets).reduce((total, asset) => total + asset.bytes, 0);

export interface RuntimeProfile {
  id: string;
  label: string;
  architecture: "x86" | "x86_64" | "riscv64";
  bits: 32 | 64;
  memoryMiB: number;
  runtimeKind: "v86" | "tinyemu" | "qemu";
  /** Linux device label; {port} is replaced with the serial port number. */
  consoleDevice?: string;
  description: string;
  downloadLabel: string;
  kernel: string;
  userland: string;
  capabilities: {
    interactiveSessions: number;
    snapshots: boolean;
    volumes?: boolean;
    evidenceMount?: boolean;
    network: "web" | "local" | "none";
    guestDns: boolean;
    guestTls: boolean;
    packageManager: string | null;
  };
  limitations: readonly string[];
}

/** Entries describe distinct pinned guest images, not shell-script presets. */
export const RUNTIME_PROFILES = {
  x86: {
    id: "x86",
    label: "Pocket PC",
    architecture: "x86",
    bits: 32,
    memoryMiB: 128,
    runtimeKind: "v86",
    consoleDevice: "ttyS{port}",
    description:
      "Buildroot with three independent serial shells and full VM checkpoints.",
    downloadLabel: "~10.2 MB",
    kernel: "6.8.12",
    userland: "Buildroot / BusyBox",
    capabilities: {
      interactiveSessions: 3,
      snapshots: true,
      volumes: true,
      evidenceMount: true,
      network: "web",
      guestDns: true,
      guestTls: false,
      packageManager: null,
    },
    limitations: [
      "32-bit x86, not x86-64.",
      "The bundled curl does not support HTTPS.",
      "No Kubernetes or container runtime is installed.",
    ],
  },
  "alpine-x86_64": {
    id: "alpine-x86_64",
    label: "Alpine x86_64",
    architecture: "x86_64",
    bits: 64,
    memoryMiB: 512,
    runtimeKind: "qemu",
    consoleDevice: "ttyS{port}",
    description:
      "Experimental 64-bit PC running Linux through QEMU in your browser.",
    downloadLabel: `~${(qemuDownloadBytes / 1_000_000).toFixed(1)} MB`,
    kernel: qemuDefault.guest.kernel,
    userland: qemuDefault.guest.userland,
    capabilities: {
      interactiveSessions: 3,
      snapshots: true,
      volumes: true,
      evidenceMount: true,
      network: "web",
      guestDns: true,
      guestTls: false,
      packageManager: "apk",
    },
    limitations: [
      "Experimental QEMU backend: 512 MiB guest RAM; the emulator reserves 2,300 MiB per instance.",
      "Default session budget: two active x86_64 machines, accounting for 4,600 MiB of Wasm reservation plus additional host allocations. Paused machines retain their slot.",
      "Three independent shells and a separate agent channel. VM checkpoints require no attached data disks or evidence.",
      "The writable root is temporary; save a VM checkpoint to preserve it before stop, reset or refresh.",
      "The supplied boot has no mounted cgroups or container/Kubernetes runtime. Guest TLS has not been verified.",
    ],
  },
  riscv64: {
    id: "riscv64",
    label: "RISC-V garden",
    architecture: "riscv64",
    bits: 64,
    memoryMiB: 128,
    runtimeKind: "tinyemu",
    consoleDevice: "hvc{port}",
    description:
      "The compact original RISC-V64 guest, with a 4 MiB writable disk.",
    downloadLabel: "~8.3 MB",
    kernel: "4.15.0",
    userland: "BusyBox 1.21.1",
    capabilities: {
      interactiveSessions: 1,
      snapshots: false,
      network: "web",
      guestDns: false,
      guestTls: false,
      packageManager: null,
    },
    limitations: [
      "Historical Linux 4.15 kernel and BusyBox 1.21.1.",
      "General hostname resolution is missing; webget works with Browser bridge.",
      "One console, no checkpoints, no Kubernetes.",
    ],
  },
  "alpine-riscv64": {
    id: "alpine-riscv64",
    label: "Alpine 3.24",
    architecture: "riscv64",
    bits: 64,
    memoryMiB: 128,
    runtimeKind: "tinyemu",
    consoleDevice: "hvc{port}",
    description:
      "Official Alpine 3.24.3 userspace with musl, BusyBox 1.37, and apk.",
    downloadLabel: "~7.5 MB",
    kernel: "4.15.0",
    userland: "Alpine Linux 3.24.3",
    capabilities: {
      interactiveSessions: 1,
      snapshots: false,
      network: "web",
      guestDns: true,
      guestTls: false,
      packageManager: "apk",
    },
    limitations: [
      "Modern Alpine userspace on the compatible historical Linux 4.15 kernel.",
      "Package installation requires a working network transport; repository CORS can block Browser bridge.",
      "One console, no checkpoints, no Kubernetes or container runtime.",
    ],
  },
  "debian-riscv64": {
    id: "debian-riscv64",
    label: "Debian 13 slim",
    architecture: "riscv64",
    bits: 64,
    memoryMiB: 128,
    runtimeKind: "tinyemu",
    consoleDevice: "hvc{port}",
    description:
      "Official Debian 13.7 userspace with Bash, GNU tools, glibc 2.41, and apt.",
    downloadLabel: "~36 MB",
    kernel: "4.15.0",
    userland: "Debian GNU/Linux 13.7",
    capabilities: {
      interactiveSessions: 1,
      snapshots: false,
      network: "web",
      guestDns: true,
      guestTls: false,
      packageManager: "apt",
    },
    limitations: [
      "Modern Debian userspace on the compatible historical Linux 4.15 kernel.",
      "A verified Alpine BusyBox and musl loader supply small boot/network utilities; Debian system libraries are preserved.",
      "One console, no checkpoints, no systemd boot or Kubernetes.",
    ],
  },
} as const satisfies Record<string, RuntimeProfile>;

export type RuntimeProfileId = keyof typeof RUNTIME_PROFILES;
export type ProfilesForRuntime<Kind extends RuntimeProfile["runtimeKind"]> = {
  [Id in RuntimeProfileId]: (typeof RUNTIME_PROFILES)[Id]["runtimeKind"] extends Kind
    ? Id
    : never;
}[RuntimeProfileId];
export type TinyEmuProfileId = ProfilesForRuntime<"tinyemu">;
export type QemuProfileId = ProfilesForRuntime<"qemu">;

export function isTinyEmuProfileId(id: RuntimeProfileId): id is TinyEmuProfileId {
  return RUNTIME_PROFILES[id].runtimeKind === "tinyemu";
}

export function isQemuProfileId(id: RuntimeProfileId): id is QemuProfileId {
  return RUNTIME_PROFILES[id].runtimeKind === "qemu";
}

export function consoleDeviceLabel(id: RuntimeProfileId, port: number): string {
  return getRuntimeProfile(id).consoleDevice?.replace("{port}", String(port)) ?? `Serial ${port}`;
}

export function isRuntimeProfileId(value: unknown): value is RuntimeProfileId {
  return typeof value === "string" && Object.hasOwn(RUNTIME_PROFILES, value);
}

export function getRuntimeProfile(id: RuntimeProfileId): RuntimeProfile {
  return RUNTIME_PROFILES[id];
}
