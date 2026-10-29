# Guest image provenance and assembly

The profile registry describes distinct guest images. It does not count different init scripts or workload names as separate operating systems. The x86 profile remains v86/Buildroot. QEMU supplies experimental Alpine x86_64; its exact integration is documented in [qemu-runtime.md](qemu-runtime.md). TinyEMU supplies three RISC-V64 images: the original small BusyBox disk, Alpine 3.24.3, and Debian 13.7 slim.

The newer RISC-V profiles boot modern userspaces on the existing, verified **Linux 4.15.0-00049-ga3b1e7a-dirty** kernel. The distribution version is not the kernel version. These are RISC-V64 machines, not x86-64, and no Kubernetes or container compatibility is claimed.

## Accepted upstream bytes

The machine-readable record is [guest-profiles.json](../public/runtime/tinyemu/guest-profiles.json); [provenance.json](../public/runtime/tinyemu/provenance.json) records the shared emulator, firmware, and kernel.

| Image                 | Accepted source                                                                                    | Compressed bytes | SHA-256                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------ |
| Alpine 3.24.3 RV64    | Official `alpinelinux/docker-alpine` commit `5aec467fb81238bae9441eea2edb000655d7044f`             | 3,450,383        | `9714553757e7bf645eff5dcc52bdd206f358a7bed77874842567852e8326a51d` |
| Debian 13.7 slim RV64 | Official `debuerreotype/docker-debian-artifacts` commit `64a870d7670389268c0d44ec0e0a4392d36d579c` | 28,345,669       | `a81ae23cfcc12d03cee9e3704fa559c027af15fefe8c60924add8fd17e4c98c1` |

Alpine's digest was independently matched against its [official release checksum](https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/riscv64/alpine-minirootfs-3.24.3-riscv64.tar.gz.sha256). Debian's digest is the layer digest in its [pinned official OCI manifest](https://raw.githubusercontent.com/debuerreotype/docker-debian-artifacts/64a870d7670389268c0d44ec0e0a4392d36d579c/trixie/slim/oci/blobs/image-manifest.json). Immutable GitHub raw URLs provide browser CORS access. The exact URLs and sizes are in `src/lib/tinyemu-assets.ts` and the public manifest.

No rootfs tarball, firmware, or kernel is included in the repository or static build. The browser downloads and verifies each required asset after Boot, with credentials and referrer omitted. Changed bytes fail integrity checking. Debian also downloads the same Alpine archive for two small boot utility files.

## Deterministic browser assembly

`public/runtime/tinyemu/filesystem.js` decompresses the verified archive and parses its tar entries into memory. It checks header checksums, sizes, path syntax, link targets, directory parents, and resource bounds. No archive entry is extracted onto the host filesystem. Unknown remote filesystem URLs are refused by the worker's in-memory loader.

The parser accepts at most 64 MiB of compressed input, 192 MiB of expanded tar, 64 MiB per file, and 20,000 entries. It serializes entries in deterministic code-point order into TinyEMU's 9p file-list format and serves file contents from memory. The virtual filesystem quota is 256 MiB; browser/emulator memory limits can be reached earlier. This is a boot-image assembler, not a forensic tar preservation tool: it does not preserve every extended attribute or original hard-link identity.

Both archive profiles receive the application-owned `/terrarium-init` and `/etc/inittab`. The init mounts proc/sysfs and starts a supervised shell on the genuine `hvc0` console. Alpine uses its BusyBox shell; Debian uses Bash. The runtime then configures the selected VPC/subnet IP and gateway and installs `webget` before user init runs.

Debian's slim container image has no suitable small init or net-tools package. Assembly therefore copies two verified files from the Alpine archive:

- `/bin/busybox` to `/usr/lib/terrarium/busybox`.
- `/lib/ld-musl-riscv64.so.1` to `/usr/lib/ld-musl-riscv64.so.1`, reachable through Debian's existing `/lib` symlink.

Explicit applet symlinks supply `ifconfig`, `route`, `ping`, `nslookup`, `nc`, `wget`, and `httpd`. Debian's glibc, Bash, core tools, apt, and package database are preserved. This mixed bootstrap is disclosed in the registry and public provenance; it is not represented as an unchanged stock Debian VM boot.

## Package licenses and corresponding sources

Alpine and Debian are collections with per-package licenses, not single-license binaries. Their files remain governed by those licenses. The MIT TinyEMU license and Apache-2.0 application license do not relicense the guests.

Alpine retains its installed APK database at `/lib/apk/db/installed`. Records include package names, versions, SPDX license identifiers, source package names, and exact aports commits. Relevant bootstrap components are:

| Component          | Version    | SPDX license | Source recipe pin                                 |
| ------------------ | ---------- | ------------ | ------------------------------------------------- |
| BusyBox            | 1.37.0-r31 | GPL-2.0-only | aports `c3ef5d10e6ef6528852c51f0564963e2f8c1be19` |
| musl               | 1.2.6-r3   | MIT          | aports `8f79d39391b46d6dbf1800fb68b8212a21d5ee2e` |
| apk-tools / libapk | 3.0.8-r0   | GPL-2.0-only | aports `4588b452722bd4800efdc6cce4f6e980e02a997f` |

The [Alpine aports repository](https://gitlab.alpinelinux.org/alpine/aports) provides source recipes, upstream archive references, and patches at those commits. Other image packages include their own license identifiers, including OpenSSL libraries, CA certificates, zlib, and Alpine base files.

Debian retains package copyright/license files under `/usr/share/doc/*/copyright`. Its [pinned artifact tree](https://github.com/debuerreotype/docker-debian-artifacts/tree/64a870d7670389268c0d44ec0e0a4392d36d579c/trixie/slim) contains package versions, release metadata, source/archive references, and debuerreotype build information. The image was built with debuerreotype 0.17 against the 2026-10-27 snapshot. These references make image provenance inspectable; an operator redistributing a derived image still needs to meet each component's source/notice obligations. Terrarium distributes assembly code, not those guest binaries.

## Reproducing verification

```sh
npm ci
npm run runtime:prepare
node --experimental-strip-types scripts/smoke-profiles.mjs
```

The smoke fetches the pinned assets into memory and executes the shipped TinyEMU worker in Node's WebAssembly engine. It boots both modern guests and verifies OS/tool versions, init output, actual exit codes, Unicode/files, native DNS, native HTTP, `webget`, and pause/resume. Both machines use the assigned **10.42.7.0/24** subnet and **10.42.7.1** gateway, exercising the nondefault VPC path.

HTTP responses in this smoke come from a deterministic host fixture through the actual guest packet bridge. Package managers are present and their versions execute; downloading/installing arbitrary packages and guest TLS through a remote relay have not been integration-verified. Package repository CORS may prevent Browser bridge use, while a separately operated Wisp relay has its own reachability policy.

The application build does not need to reconstruct either distribution from source. Its reproducible input is the exact official, hash-pinned image plus the committed assembler. Rebuilding the distributions themselves uses their referenced upstream build recipes and source archives.

## Scope of additional architectures

The x86_64 profile uses a separate QEMU-Wasm backend; it does not reuse the JSLinux x86_64 emulator. Its immutable upstream image commit, byte hashes, source-reference limitations, local loader license, temporary root behavior and shared-memory requirements are recorded in [QEMU provenance](../public/runtime/qemu/provenance.json) and [the runtime documentation](qemu-runtime.md). ARM64 remains a separate unverified backend target and is not listed as a bootable profile. Arbitrary user boot manifests and unverified OS entries are not exposed.
