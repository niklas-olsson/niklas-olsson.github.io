// SPDX-License-Identifier: Apache-2.0

export interface TinyEmuAsset {
  name: string;
  url: string;
  bytes: number;
  sha256: string;
}

// This immutable CORS-capable mirror was checked byte for byte against the
// author's jslinux-2019-12-21 release. Guest binaries stay outside our build.
const MIRROR =
  "https://raw.githubusercontent.com/losfair/jslinux-wstunnel/bbc541599d2ce6d55a63f9fbd40a00da3f1b00b9/";
export const TINYEMU_GUEST_ASSETS = {
  bios: {
    name: "RISC-V boot loader",
    url: `${MIRROR}bbl64.bin`,
    bytes: 53_786,
    sha256: "293610cea7af6c75e4a8337e16c0d62834becbf31ffd9cca35e0c211602349db",
  },
  kernel: {
    name: "RISC-V64 Linux kernel",
    url: `${MIRROR}kernel-riscv64.bin`,
    bytes: 3_979_556,
    sha256: "65ca70a6560a730396ab61488d1cf46089b32da5af7e535e03c180cd5bcc8e75",
  },
  disk: {
    name: "RISC-V64 BusyBox root disk",
    url: `${MIRROR}root-riscv64.bin`,
    bytes: 4_194_304,
    sha256: "04c4e67351934c3b81602698adf56f39961f53fe630f2920ad15bc9c12da971b",
  },
} satisfies Record<string, TinyEmuAsset>;

export const TINYEMU_WASM = {
  name: "TinyEMU WebAssembly",
  bytes: 220_054,
  sha256: "4e4d5d60713bab852a1e95b673fbb26d805010b8acbffce9a860e4f3fb88196b",
};

/** Official Alpine archive, also matched against its published SHA-256 file. */
export const ALPINE_RISCV64_ROOTFS: TinyEmuAsset = {
  name: "Alpine 3.24.3 RISC-V64 root filesystem",
  url: "https://raw.githubusercontent.com/alpinelinux/docker-alpine/5aec467fb81238bae9441eea2edb000655d7044f/riscv64/alpine-minirootfs-3.24.3-riscv64.tar.gz",
  bytes: 3_450_383,
  sha256: "9714553757e7bf645eff5dcc52bdd206f358a7bed77874842567852e8326a51d",
};

/** The layer digest comes from the official debuerreotype OCI manifest. */
export const DEBIAN_RISCV64_ROOTFS: TinyEmuAsset = {
  name: "Debian 13.7 slim RISC-V64 root filesystem",
  url: "https://raw.githubusercontent.com/debuerreotype/docker-debian-artifacts/64a870d7670389268c0d44ec0e0a4392d36d579c/trixie/slim/oci/blobs/rootfs.tar.gz",
  bytes: 28_345_669,
  sha256: "a81ae23cfcc12d03cee9e3704fa559c027af15fefe8c60924add8fd17e4c98c1",
};

export const TINYEMU_PROFILE_ASSETS = {
  riscv64: TINYEMU_GUEST_ASSETS,
  "alpine-riscv64": {
    bios: TINYEMU_GUEST_ASSETS.bios,
    kernel: TINYEMU_GUEST_ASSETS.kernel,
    rootfs: ALPINE_RISCV64_ROOTFS,
  },
  "debian-riscv64": {
    bios: TINYEMU_GUEST_ASSETS.bios,
    kernel: TINYEMU_GUEST_ASSETS.kernel,
    rootfs: DEBIAN_RISCV64_ROOTFS,
    supportRootfs: ALPINE_RISCV64_ROOTFS,
  },
} satisfies Record<string, Record<string, TinyEmuAsset>>;
