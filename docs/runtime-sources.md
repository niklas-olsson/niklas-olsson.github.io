# Runtime source distribution

Terrarium distributes browser runtime binaries together with their component
notices and the corresponding-source companions listed below. Terrarium's
application code is licensed under Apache-2.0. QEMU, Linux, firmware, guest
packages, fonts and other dependencies retain their own licenses.

This page describes the published runtime source artifacts. It does not claim
that an application release, a new runtime build, a browser model integration or
a particular browser/device configuration has passed qualification.

## Active source companion

The runtime source manifest at
[`runtime/qemu/source-manifest.json`](../runtime/qemu/source-manifest.json)
selects this archive for the currently described five owned QEMU runtime bundles
and their shared Alpine 3.21.4/Linux 6.12.38-0-virt guest:

- [terrarium-runtime-corresponding-source-20261104.tar.gz](https://github.com/niklas-olsson/niklas-olsson.github.io/releases/download/runtime-sources-s2/terrarium-runtime-corresponding-source-20261104.tar.gz)
- Complete size: **301580320 bytes**.
- SHA-256: `cd990c10bf89c5af80237359cafbe81398a53bcbfa1de253ad2a63e5f4a2621c`.

The gzip-compressed POSIX tar contains only regular files under
`terrarium-s2-runtime-corresponding-source/`. Its 541 payload members include 39
unchanged upstream inputs, reconstruction recipes, local patches, component
records, original notices and the source-control files needed by those recipes.
The member inventory accompanies the archive and is also available at
[`runtime/qemu/source-archive-members.json`](../runtime/qemu/source-archive-members.json).
The inventory excludes itself; its exact bytes and the complete archive are
bound by the source manifest.

The download URL identifies a distribution location. Verify the complete byte
count and SHA-256 after downloading; the existence of this page or manifest does
not independently establish current network availability.

## Retained source artifacts

These earlier or separately scoped source assets remain available. They have
different identities and must not be substituted for the active archive above.

| Source artifact | Complete bytes | SHA-256 |
| --- | ---: | --- |
| [Earlier S2 companion](https://github.com/niklas-olsson/niklas-olsson.github.io/releases/download/runtime-sources-s2/terrarium-s2-runtime-corresponding-source.tar.gz) | 301580245 | `6dab3bfbf2a505007e090dc4b26698498d9a3b3d06b3851e84d4ca1177b0de59` |
| [Host-fence source companion](https://github.com/niklas-olsson/niklas-olsson.github.io/releases/download/runtime-source-host-fence-20261106/terrarium-runtime-corresponding-source-host-fence-20261106.tar.gz) | 301580491 | `0d9d9f22c16ac9db36e435eb9dda6f3218f510acb9c98212657f90e60aa056d3` |

The host-fence companion is a source-only artifact. It does not establish a new
application/binary release, runtime qualification or LLM integration acceptance.
Release tags in this distribution repository are pointers to the current public
snapshot. Each named source archive and its digest retain an independent
identity; the GitHub-generated repository ZIP/tar is not a replacement for a
corresponding-source companion.

## Inspecting and reconstructing

First verify the downloaded archive against its complete size and digest. Inspect
the closed member inventory before extracting into a fresh directory. The active
archive contains `build/qemu/source_archive.py`, `build/qemu/README.md`, the
historical reconstruction directories, patches and component records. Its
`source-inputs/` directory contains the unchanged upstream input files.

After safe extraction, the reconstruction instructions are in
`terrarium-s2-runtime-corresponding-source/build/qemu/README.md`. Paths in that kit
are relative to its root. The source recipes use Linux x86_64, Python 3.12 or newer
and the declared native build tools. Follow the exact historical recipe and
locked inputs for the runtime variant being inspected.

The companion is a runtime reconstruction kit, not the complete application
development tree. Its historical instructions refer to `public/runtime/qemu/`
when checking the distributed runtime. Those matching public binary assets are
served at [`runtime/qemu/`](../runtime/qemu/catalog.js) in this distribution. To
use the kit's preparation checks, place a copy of the matching distribution's
`runtime/qemu/` files under the extracted kit's `public/runtime/qemu/`, preserving
the kit's reconstruction sources, notices and inventory. The exact accepted
bytes remain identified by the catalog and per-bundle provenance; mixing a
different runtime distribution with this kit is not a valid identity check.

The companion includes target component sources and reconstruction controls. It
still uses separately fetched, locked prebuilt compiler/SDK and guest inputs.
It does not contain a complete source-built compiler bootstrap. The historical
kernel and firmware compiler environments have not been reproduced. The supplied
initramfs has retained file hashes and identified component sources, but not an
exhaustive file-to-package provenance attestation. Source closure and availability
do not establish byte-for-byte regeneration or application qualification.

## Notices

See [runtime third-party notices](../runtime/THIRD_PARTY_NOTICES.md), the
[application license](../LICENSE),
[QEMU license explanation](../runtime/qemu/QEMU-LICENSE.txt),
[GPL text](../runtime/qemu/QEMU-COPYING.txt) and
[Emscripten notices](../runtime/qemu/Emscripten-LICENSE.txt). Component notice files
remain under `runtime/licenses/`, `runtime/tinyemu/` and
`runtime/qemu/licenses/`. Runtime and guest provenance records identify upstream
origins, exact accepted bytes and known limitations.

Legacy guest images that are fetched directly from upstream on explicit boot
remain distinct from the locally distributed owned guest. Their download pins do
not establish a complete corresponding-source bundle for an independently
redistributed image.
