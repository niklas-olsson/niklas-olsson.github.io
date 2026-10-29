# Owned runtime reconstruction

This directory contains the compilation and guest assembly sources for all five locally distributed owned QEMU bundles. Exact recipe, lock and patch identities are mapped in `distribution/manifest.json`. The current recipe builds S1 V3. Historical S1 V2 uses the unchanged recipe and lock in `reconstruction/owned-s1-candidate-v2/`; substituting the current recipe changes its identity. The three server recipes are preserved under their respective `reconstruction/owned-s2-server-v*/` directories and can also be derived by `build-machine-runtime.py`, `build-machine-runtime-v2.py` and `build-machine-runtime-v3.py`.

The separate [runtime source distribution guide](../../docs/runtime-sources.md) explains component sources, licenses, archive layout, verification and limitations. Original compressed source inputs are distributed separately from Git. They must retain their original bytes and filenames.

## Host and input requirements

Use Linux x86_64, Python 3.12 or newer, a native C compiler and standard C/POSIX headers, GNU Make, Perl, patch and pip. The recipes were designed for GCC 13.3.0 and e2fsprogs 1.47.0. Guest assembly rejects a different e2fsprogs version. Native host tools are host prerequisites; their complete source rebuild environment is not claimed here.

`inputs.lock.json` pins QEMU, libraries, Meson subprojects, Emscripten 3.1.50 SDK/compiler binaries, Node 16.20.0 (compiler helper only), host-tool archives and Python wheels. `guest-inputs.lock.json` pins Alpine's minirootfs, ISO and aports. `guest-tools.lock.json` pins guest extraction dependencies. `distribution-inputs.lock.json` pins additional guest and firmware sources. These locks are unchanged. The two extra Netbase files are identified by their original APKBUILD SHA512 values in `distribution/manifest.json`; they supplement the source selection without changing a lock.

## Build commands

From the repository root, select an absolute writable `CACHE` and empty `TOOLS`, `WORK`, `GUEST` and `PACK` directories. Copy `source-inputs/*` from the companion into `CACHE`. The companion includes target sources and selected extraction tools; it excludes the prebuilt SDK, ISO/minirootfs and other locked build inputs. Fetch those remaining inputs with the unchanged fetcher. It verifies sizes and SHA256, reuses correct cached files and rejects mismatches.

```sh
RECIPE=build/qemu/reconstruction/owned-s1-candidate-v2
# Historical S1 V2 uses its all-in-one CLI.
python3 -B build/qemu/fetch-inputs.py --lock "$RECIPE/inputs.lock.json" --cache-dir "$CACHE"
python3 -B build/qemu/fetch-inputs.py --lock build/qemu/guest-inputs.lock.json --cache-dir "$CACHE"
python3 -B build/qemu/fetch-inputs.py --lock build/qemu/guest-tools.lock.json --cache-dir "$CACHE"
python3 -B build/qemu/bootstrap-tools.py --cache-dir "$CACHE" --work-dir "$TOOLS" --jobs 4
python3 -B "$RECIPE/build-runtime.py" --cache-dir "$CACHE" --work-dir "$WORK" \
  --sdk-dir "$TOOLS/sdk" --host-tools-dir "$TOOLS/host" \
  --python-tools-dir "$TOOLS/python-tools" --jobs 4
```

For S1 V3, select the current recipe; for a server, select its corresponding reconstruction directory instead. These recipes support the verified two-stage CLI below. Fetch the selected recipe's locked inputs with the fetcher above and use a fresh `WORK` directory for that variant.

```sh
RECIPE=build/qemu
python3 -B "$RECIPE/build-runtime.py" --cache-dir "$CACHE" --work-dir "$WORK" \
  --sdk-dir "$TOOLS/sdk" --host-tools-dir "$TOOLS/host" \
  --python-tools-dir "$TOOLS/python-tools" --jobs 4 --stage dependencies
python3 -B "$RECIPE/build-runtime.py" --cache-dir "$CACHE" --work-dir "$WORK" \
  --sdk-dir "$TOOLS/sdk" --host-tools-dir "$TOOLS/host" \
  --python-tools-dir "$TOOLS/python-tools" --jobs 4 --stage qemu
```

After the selected runtime build completes, assemble and package the shared guest:

```sh
python3 -B build/qemu/build-guest.py --cache-dir "$CACHE" --work-dir "$GUEST" \
  --host-tools-dir "$TOOLS/host" --python-tools-dir "$TOOLS/python-tools"
python3 -B build/qemu/package-guest.py --guest-dir "$GUEST/artifacts" \
  --sdk-dir "$TOOLS/sdk" --work-dir "$PACK"
```

S1 V2's historical bootstrap can instead be invoked from its reconstruction directory to retain that bootstrap's exact identity. S1 V2 uses the supplied SDK cache. Current S1 V3 and all server recipes copy the supplied Emscripten source privately, apply the proxy-context backport, start with an empty private standard-library cache and rebuild the affected system libraries. Neither workflow rebuilds LLVM/Binaryen executable tools from source. Keep historical recipe bytes unchanged when checking binary provenance.

Each stage must complete successfully before the next stage consumes its output. Current recipes check a dependency boundary and reject drift. Use fresh work directories after failure; a partial compile is not a completed build. Default stage bounds are finite; the current recipes cap parallel compiler pools at four. No compile or binary reproduction is established by the source closure checks.

## Variants and modifications

| Runtime | Wasm reservation | Guest target | Source modifications |
| --- | --- | --- | --- |
| S1 V2 | 2300 MiB | 512 MiB, 1 CPU | GLib stable runtime paths |
| S1 V3 | 2300 MiB | 512 MiB, 1 CPU; Worker config uses 1024 MiB | GLib paths; Emscripten proxy lifetime backport |
| Server V1 | 3584 MiB | 2048 MiB, 2 CPUs | S1 V3 modifications |
| Server V2 | 3584 MiB | 2048 MiB, 2 CPUs | Server V1 plus QEMU unsigned address/context and split RAM corrections |
| Server V3 | 3584 MiB | 2048 MiB, 2 CPUs | Server V2 plus libffi unsigned address correction |

Wasm reservations differ from guest RAM and observed browser resident memory. Exact machine profile definitions are in the derived locks and `machine-recipe.json` files, with browser topology in `public/runtime/qemu/catalog.js` and `machine-config.js`.

The proxy patch backports Emscripten commit `f3fef05bf5d63df33ed21eb067b86d827c546bfa`. Original attribution is preserved. GLib uses stable virtual runtime paths rooted at `/terrarium-runtime`. QEMU corrections check exact before/after source identities; server V2/V3 use two 1024 MiB RAMBlocks and fixed topology. Libffi V3 checks unsigned heap indexing, stack alignment and structure copies. Patch bytes and variant applicability are bound in the manifest.

`build-guest.py` assembles identified Alpine binaries; it does not compile Linux. It extracts Linux 6.12.38-0-virt and its initramfs from the official ISO, adds the exact ext2 module dependency overlay, and assembles the minirootfs into a normalized ext4 image with `mke2fs.conf`. It supplies BusyBox init, mdev, proc/sys/devpts mounts and a passwordless serial root account for the isolated laboratory. `package-guest.py` uses the SDK file packager, including the compressed root package. QEMU's pinned archive supplies five firmware binaries. Kernel, firmware and initramfs compilation environments are not reconstructed. The Alpine recipes, kernel configuration, module list, installed package declarations and initramfs file inventory are retained in `distribution/`.

Subsequent browser bootstrap adaptation is in `scripts/qemu-pthread-transform.mjs`, with the original generated source under `vendor/qemu/owned-s1-candidate-v2/`. `scripts/prepare-qemu.mjs` checks exact generated bootstrap and bundle pins. It requires the application checkout and its distributed binary assets; the source companion alone is a reconstruction kit.

## Focused checks

```sh
python3 -B build/qemu/test_runtime_build_support.py
python3 -B build/qemu/test_machine_runtime_recipe.py
python3 -B build/qemu/test_source_closure.py
python3 -B build/qemu/source_archive.py check
python3 -B build/qemu/source_archive.py verify --archive "$ARCHIVE"
```

These check source integrity, historical identities, dependency closure and archive binding. They do not run QEMU, compile Linux, qualify the application or attest historical source delivery.
