# Third-party notices

Terrarium's application code and its third-party dependencies have separate licenses. Rebranding the application does not change or remove those licenses. Complete dependency versions and npm integrity records are in `package-lock.json`.

## Software included in the static site

| Component | Version/source | License | Included notice |
| --- | --- | --- | --- |
| v86 emulator | npm `v86@0.5.472`; source commit `cc37f35c43bf14865d74ad76879ecf9410f69eb1` | BSD-2-Clause | `public/runtime/licenses/v86-BSD-2-Clause.txt` |
| TinyEMU RISC-V64 emulator | Fabrice Bellard's `2019-12-21` JS/Wasm release | MIT | `public/runtime/tinyemu/MIT-LICENSE.txt` |
| Emscripten pthread loader for QEMU | Adapted `alpine-x86_64/qemu-system-x86_64.worker.js` from artifact commit `b7c549b5e6f4c376f76483a03e983214421434ad` | MIT, original copyright header retained | `public/runtime/qemu/Emscripten-LICENSE.txt` |
| Owned QEMU x86_64 bundles and Alpine guest components | Exact identities in `public/runtime/qemu/catalog.js` and per-bundle provenance | GPL and component-specific upstream terms | `public/runtime/qemu/QEMU-COPYING.txt`, `public/runtime/qemu/QEMU-LICENSE.txt`, and `public/runtime/qemu/licenses/` |
| AES and SHA-256 code bundled with TinyEMU | Public-domain Rijndael implementation and LibTomCrypt implementation supplied in TinyEMU source | Public-domain/permissive upstream notices | `public/runtime/tinyemu/THIRD_PARTY_NOTICES.txt` |
| Berkeley SoftFloat, bundled in v86 | Release 3e; notice headers preserved from the pinned v86 source | BSD-3-Clause | `public/runtime/licenses/SoftFloat-notices.txt` |
| Zstandard decoder, bundled in v86 | 1.4.5; the BSD license option is used | BSD-3-Clause | `public/runtime/licenses/Zstandard-BSD.txt` |
| QEMU-derived floppy-controller portions, bundled in v86 | v86's `LICENSE.MIT` at the pinned source commit | MIT | `public/runtime/licenses/v86-QEMU-MIT.txt` |
| React, React DOM, and scheduler | Installed versions recorded in `package-lock.json` | MIT | `public/runtime/licenses/React-MIT.txt`, `React-DOM-MIT.txt`, `React-scheduler-MIT.txt` |
| xterm.js and fit addon | Installed versions recorded in `package-lock.json` | MIT | `public/runtime/licenses/xterm-MIT.txt`, `xterm-addon-fit-MIT.txt` |
| Lucide icons | Installed version recorded in `package-lock.json` | ISC, including notices for derived icons | `public/runtime/licenses/Lucide-ISC.txt` |
| DM Sans variable font | `@fontsource-variable/dm-sans@5.3.0`; DM Sans Project Authors | SIL Open Font License 1.1 | `public/runtime/licenses/DM-Sans-OFL-1.1.txt` |
| Manrope variable font | `@fontsource-variable/manrope@5.3.0`; Manrope Project Authors | SIL Open Font License 1.1 | `public/runtime/licenses/Manrope-OFL-1.1.txt` |

The preparation script copies complete license texts from installed npm packages. The additional v86 notices are committed files extracted from the upstream sources. Vite, TypeScript, and other development tools are build dependencies rather than the guest operating system. Their package licenses remain in their npm packages and are recorded by the lockfile.

The two font families are served locally as application assets. Their font software remains under the SIL Open Font License; Terrarium's Apache license does not replace it.

### Emulator provenance

- [Official v86 source at the pinned commit](https://github.com/copy/v86/tree/cc37f35c43bf14865d74ad76879ecf9410f69eb1)
- [npm release metadata](https://registry.npmjs.org/v86/0.5.472)
- [npm provenance record](https://registry.npmjs.org/-/npm/v1/attestations/v86@0.5.472)
- [Bundled SoftFloat source and notice headers](https://github.com/copy/v86/blob/cc37f35c43bf14865d74ad76879ecf9410f69eb1/lib/softfloat/softfloat.c)
- [Bundled Zstandard decoder](https://github.com/copy/v86/blob/cc37f35c43bf14865d74ad76879ecf9410f69eb1/lib/zstd/zstddeclib.c) and [Zstandard 1.4.5 BSD license](https://github.com/facebook/zstd/blob/v1.4.5/LICENSE)
- [v86 QEMU-derived code license](https://github.com/copy/v86/blob/cc37f35c43bf14865d74ad76879ecf9410f69eb1/LICENSE.MIT)

`public/runtime/provenance.json` lists the expected lengths and SHA-256 digests of the actual redistributed JS/Wasm files. Its Git commit comes from npm's published provenance record. `npm ci` verifies the package integrity, and `npm run runtime:prepare` independently verifies these three assets before copying them.

The v86 JavaScript receives one deterministic integration patch: it exports the existing Fetch and Wisp backend constructors so each network port can own their explicit lifecycle, plus the generic VirtIO PCI transport used by Terrarium’s own block-device handler. Upstream and patched asset hashes and the patch description are recorded in that manifest. The emulator/backend implementations are not replaced, and the BSD notice is retained.

TinyEMU's two committed runtime binaries are unmodified files from [the author's JavaScript release](https://bellard.org/tinyemu/jslinux-2019-12-21.tar.gz). Its [MIT source release](https://bellard.org/tinyemu/tinyemu-2019-12-21.tar.gz), release/archive digests, binary hashes, and runtime configuration are recorded in `public/runtime/tinyemu/provenance.json`. `scripts/prepare-tinyemu.mjs` verifies the files and required notices without network access. The application-owned worker/adapter and guest helper are separate Apache-2.0 integration code.

The QEMU integration includes the MIT-licensed Emscripten pthread bootstrap with documented, nonfunctional comment cleanup and a bounded URL-resolution adaptation, data-only package metadata and application-owned adapters. `scripts/prepare-qemu.mjs` verifies the loader and metadata by length/SHA-256 without network access. The legacy GPL QEMU executable module/Wasm, guest kernel, firmware and root package are downloaded from upstream on Boot. The historical upstream binaries are not mirrored. Five registered owned QEMU bundles and their shared owned Alpine 3.21.4/Linux 6.12.38-0-virt guest are distributed at application-local paths. Their original component notices remain under `public/runtime/qemu/licenses/`. Exact sources, local modifications, historical recipes, build limitations and the same-distribution source companion are described in [runtime source guide](docs/runtime-sources.md) and `public/runtime/qemu/source-manifest.json`. The manifest identifies its stable GitHub Releases download URL; verify the complete size, SHA-256 and closed membership after retrieval. Byte registration does not establish release qualification. `public/runtime/qemu/provenance.json` records every accepted asset, its immutable artifact commit, memory requirements and the limitations of the available source provenance. The complete upstream QEMU license explanation and GPL text are provided as reference notices in that directory; they do not relicense Terrarium's own code.

## Guest binaries fetched directly from upstream

The following legacy profiles download kernel/root filesystem and firmware files directly into the visitor's browser from the upstream origins listed below. The locally shipped owned guest has the separate source distribution described above. The browser checks their pinned lengths and SHA-256 digests before passing them to the emulator.

| Asset | Upstream source | Known provenance |
| --- | --- | --- |
| `buildroot-bzimage68.bin` | [v86 image host](https://i.copy.sh/buildroot-bzimage68.bin) | Kernel header identifies Linux 6.8.12, built 31 August 2024. The exact Buildroot configuration and full root filesystem source/license bundle have not been established. |
| `seabios.bin`, `vgabios.bin` | The `bios/` directory at the pinned v86 commit above | Upstream's [build script](https://github.com/copy/v86/blob/cc37f35c43bf14865d74ad76879ecf9410f69eb1/bios/fetch-and-build-seabios.sh) selects [SeaBIOS `rel-1.16.2`](https://github.com/coreboot/seabios/tree/rel-1.16.2) and the adjacent configuration. SeaBIOS has its own GPL/LGPL terms. |
| `bbl64.bin`, `kernel-riscv64.bin`, `root-riscv64.bin` | [Immutable CORS-capable TinyEMU demo mirror](https://github.com/losfair/jslinux-wstunnel/tree/bbc541599d2ce6d55a63f9fbd40a00da3f1b00b9) | All three files were independently hash-matched against Bellard's official 2019-12-21 release. Kernel/boot-loader source commits, patches, and configurations are referenced in the [official disk-image archive](https://bellard.org/tinyemu/diskimage-linux-riscv-2018-09-23.tar.gz). The exact complete source/build bundle for the minimal BusyBox 1.21.1 root image is not established. |
| Alpine 3.24.3 RISC-V64 minirootfs | [Official Alpine artifact commit](https://github.com/alpinelinux/docker-alpine/tree/5aec467fb81238bae9441eea2edb000655d7044f/riscv64) | The compressed archive hash also matches Alpine's official release checksum. Its APK database retains package versions, SPDX identifiers, source package names, and exact aports source-recipe commits. |
| Debian 13.7 slim RISC-V64 rootfs | [Official debuerreotype artifact commit](https://github.com/debuerreotype/docker-debian-artifacts/tree/64a870d7670389268c0d44ec0e0a4392d36d579c/trixie/slim) | The accepted SHA-256 is the official OCI layer digest. The artifact tree retains package/build/release metadata and snapshot archive references; package copyright files remain in the guest. |
| QEMU 8.2.0 Wasm/JS and Alpine x86_64 kernel, initramfs, firmware and root packages | [Pinned upstream QEMU-Wasm demo artifacts](https://github.com/ktock/qemu-wasm-demo-images/tree/b7c549b5e6f4c376f76483a03e983214421434ad/alpine-x86_64) | Actual guest identifies Alpine 3.21.4 and Linux 6.12.43-0-virt. QEMU is GPL-2.0 with separately licensed components; firmware and installed guest packages have their own licenses. The artifact commit does not attest the exact corresponding QEMU source revision. Reference build recipes and accepted hashes are recorded in QEMU provenance. |

The modern RISC-V images are assembled into an in-memory 9p filesystem by application-owned code after integrity verification. Alpine retains its own BusyBox/musl userspace. Debian retains its glibc, Bash, GNU utilities, apt, and package database; two verified Alpine files supply bootstrap/network utilities in `/usr/lib/terrarium` plus the musl loader path. BusyBox 1.37.0-r31 is `GPL-2.0-only` (aports commit `c3ef5d10e6ef6528852c51f0564963e2f8c1be19`); musl 1.2.6-r3 is `MIT` (aports commit `8f79d39391b46d6dbf1800fb68b8212a21d5ee2e`). These are browser-time guest downloads, not vendored application binaries.

The legacy QEMU Alpine root retains `/lib/apk/db/installed`, including package names, versions, license identifiers and aports source-recipe commits. Observed core packages include `linux-virt 6.12.43-r0` and `busybox 1.37.0-r13` under GPL-2.0-only, `musl 1.2.5-r9` under MIT, and `openrc 0.55.1-r2` under BSD-2-Clause. The browser appends a bounded initramfs override and uses a temporary writable root overlay. These integration changes do not relicense the upstream operating system or establish a complete corresponding-source bundle for the downloaded image.

Full derivation details, resource limits, exact archive pins, source references, and verification scope are recorded in [the guest profile manifest](public/runtime/tinyemu/guest-profiles.json) and [guest image documentation](docs/guest-profiles.md). The application build uses immutable upstream artifacts and committed assembly code. Rebuilding the distributions themselves uses their separately referenced source recipes and archives.

A download URL and digest establish which bytes the app accepts. They do not establish that those bytes have a complete redistributable source bundle. This project makes no claim that the guest image is covered by Terrarium's application license or v86's BSD license.

If you mirror, modify, or distribute a guest image yourself, collect and review its complete component licenses and corresponding sources. For a controlled Buildroot image, retain the build configuration, patches, toolchain details, and the output of `make legal-info`; address any warnings it reports. See [Buildroot's licensing documentation](https://buildroot.org/downloads/manual/manual.html#legal-info) and `docs/release-audit.md`.

The application makes no claim of endorsement by upstream projects. Third-party names identify actual components or explain compatibility.

## Test-only storage fixture

`fake-indexeddb@6.2.6` is an Apache-2.0 development dependency used by deterministic transaction and actual-emulator smoke tests. It is not bundled into the browser application. See its [upstream source and license](https://github.com/dumbmatter/fakeIndexedDB).
