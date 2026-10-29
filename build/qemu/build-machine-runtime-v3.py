#!/usr/bin/env python3
"""Derive the fixed S2 server V3 recipe with checked Wasm32 source corrections.

The S1 recipe and server V1/V2 runtimes remain unchanged. Reviewed source patches
are applied before a fresh dependency and QEMU compile; no artifact is rewritten.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

RECIPE = Path(__file__).resolve().parent
SERVER_RUNTIME = "qemu@8.2.0-terrarium-0ef7b4e-s2-server-v3"
SERVER_WASM_MIB = 3584
S1_RUNTIME = "qemu@8.2.0-terrarium-0ef7b4e-s1-candidate-v3"
CORRECTIONS = [{
    "files": [{"file": "tcg/wasm32.c",
        "beforeSha256": "5e551e478a5ddd86e81964dd3fc3783150d22c1691a1f918290704550e8c433a",
        "afterSha256": "2a612bd07d7aac3a220a72dd667726b63138741c25bd49dd46a9379a9b8fca44"}],
    "patch": "qemu-wasm32-address-context.patch",
    "patchSha256": "4181b961c1e69a5df6d077737feb2c9ef9646bffbc91d2fb93dc0a520e3213d9",
    "scope": "Unsigned Wasm32 address crossings and fixed guest TCG context capacity; no CPU hotplug or recycled-context support is claimed.",
}, {
    "files": [{"file": "hw/core/machine.c",
        "beforeSha256": "657808003d666107b85afef98a9e1b3f1c77272cd2cca805ae072de23e950303",
        "afterSha256": "44acc27e799a50282e66220725a3122c7fc850fdc903e8d68396665d4f2a46c3"},
        {"file": "util/mmap-alloc.c",
        "beforeSha256": "9ab54329e1298bbe32dc33d9d3efafd48364de6c97d74bc29a5db3a8adc0cea4",
        "afterSha256": "6a33f5d74f417d4fc21d3e632d4d14118bf8931aae1bd4215aa90ff3fd4db063"}],
    "patch": "qemu-wasm32-segmented-ram.patch",
    "patchSha256": "6dda5de0d181292450c6d1594d15f4ad973bc0fd4d1d193c0abf94a92ef6670c",
    "scope": "Exactly 2 GiB aggregate PC RAM in two distinct 1 GiB anonymous RAMBlocks; retain libc's per-mapping bound and preserve mmap failure semantics.",
}]
LIBFFI_CORRECTION = {
    "file": "src/wasm32/ffi.c",
    "beforeSha256": "8f13decacbdbc9faf8aa1a5e4998a64066050c84b071792f0a6c8b499b2d4f05",
    "afterSha256": "076bd6555f32539dd65f19c94d787f3cdaf3078544ed99a8e690a4b5d5e78d6f",
    "patch": "libffi-wasm32-unsigned-addresses.patch",
    "patchSha256": "52170a1e3880a45918af59c38164a4f6f875a1efa66b147f51202fca2fb4d5f1",
    "scope": "Unsigned Wasm32 heap indexing, stack alignment and struct copies in the pinned libffi bridge; function-table indices and ABI are unchanged.",
}
FILES = ("build-runtime.py", "runtime_build_support.py", "inputs.lock.json",
         "patches/glib-stable-runtime-paths.patch", "patches/emscripten-proxy-context-lifetime.patch",
         "patches/qemu-wasm32-address-context.patch", "patches/qemu-wasm32-segmented-ram.patch", "patches/libffi-wasm32-unsigned-addresses.patch")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def replace_once(data: bytes, old: bytes, new: bytes, label: str) -> bytes:
    if data.count(old) != 1:
        raise ValueError(f"{label}: expected exactly one declared S1 recipe site")
    return data.replace(old, new)


def derive_recipe(source: Path, destination: Path) -> dict:
    outputs, inputs = {}, {}
    for correction in [*CORRECTIONS, LIBFFI_CORRECTION]:
        patch = source / "patches" / correction["patch"]
        if sha256(patch.read_bytes()) != correction["patchSha256"]:
            raise ValueError("A reviewed source patch changed; give a changed patch its own identity")
    for name in FILES:
        data = (source / name).read_bytes()
        inputs[name] = {"bytes": len(data), "sha256": sha256(data)}
        if name == "build-runtime.py":
            data = replace_once(data, b"-sTOTAL_MEMORY=2300MB", b"-sTOTAL_MEMORY=3584MB", "Fixed server Wasm reservation")
            data = replace_once(data, b"The corrected recipe requires its distinct candidate-v3 runtime identity",
                                b"The corrected server recipe requires its distinct s2-server-v3 runtime identity", "Recipe identity")
            data = replace_once(data,
                b'RECIPE / "patches/emscripten-proxy-context-lifetime.patch"]}',
                b'RECIPE / "patches/emscripten-proxy-context-lifetime.patch", RECIPE / "patches/qemu-wasm32-address-context.patch", RECIPE / "patches/qemu-wasm32-segmented-ram.patch", RECIPE / "patches/libffi-wasm32-unsigned-addresses.patch"]}',
                "Stage boundary patch identity")
            data = replace_once(data,
                b'for name in ["glib-stable-runtime-paths.patch", "emscripten-proxy-context-lifetime.patch"]}',
                b'for name in ["glib-stable-runtime-paths.patch", "emscripten-proxy-context-lifetime.patch", "qemu-wasm32-address-context.patch", "qemu-wasm32-segmented-ram.patch", "libffi-wasm32-unsigned-addresses.patch"]}',
                "Build report patch identity")
            ffi_anchor = b'            run("ffi-autoreconf", ["autoreconf", "-fiv"], source / "libffi")\n'
            ffi_correction = '''            ffi = source / "libffi"
            correction = LOCK["libffiSourceCorrection"]
            source_patch = RECIPE / "patches" / correction["patch"]
            if sha256(source_patch) != correction["patchSha256"]:
                raise ValueError("libffi source correction patch differs from the reviewed identity")
            if sha256(ffi / correction["file"]) != correction["beforeSha256"]:
                raise ValueError("libffi source correction requires exact original source")
            run(correction["patch"].removesuffix(".patch"), ["patch", "--batch", "--forward", "--fuzz=0", "-p1", "-i", str(source_patch)], ffi)
            if sha256(ffi / correction["file"]) != correction["afterSha256"]:
                raise ValueError("Corrected libffi source differs from its declared identity")
            report["libffiSourceCorrection"] = dict(correction, application="checked exact original and resulting source before dependency autoreconf/compile")
            save()
            run("ffi-autoreconf", ["autoreconf", "-fiv"], source / "libffi")
'''.encode()
            data = replace_once(data, ffi_anchor, ffi_correction, "Checked pre-dependency libffi source correction")
            ffi_boundary = '''        correction = LOCK["libffiSourceCorrection"]
        observed = report.get("libffiSourceCorrection", {})
        if any(observed.get(key) != value for key, value in correction.items()):
            raise ValueError("libffi source correction receipt changed across build stages")
        if continuing and observed.get("unchangedAfterDependencies") is not True:
            raise ValueError("The continued dependency stage did not verify the corrected libffi source")
        if sha256(source / "libffi" / correction["file"]) != correction["afterSha256"]:
            raise ValueError("Corrected libffi source changed during or after dependency compilation")
        observed["unchangedAfterDependencies"] = True
        if args.stage == "dependencies":
'''.encode()
            data = replace_once(data, b'        if args.stage == "dependencies":\n', ffi_boundary,
                                "Completed dependency source identity")
            anchor = b'        qemu = source / "qemu"\n'
            correction = '''        qemu = source / "qemu"
        report["qemuSourceCorrections"] = []
        for correction in LOCK["qemuSourceCorrections"]:
            source_patch = RECIPE / "patches" / correction["patch"]
            if sha256(source_patch) != correction["patchSha256"]:
                raise ValueError("QEMU source correction patch differs from the reviewed identity")
            for item in correction["files"]:
                if sha256(qemu / item["file"]) != item["beforeSha256"]:
                    raise ValueError("QEMU source correction requires exact original source: " + item["file"])
            run(correction["patch"].removesuffix(".patch"), ["patch", "--batch", "--forward", "--fuzz=0", "-p1", "-i", str(source_patch)], qemu)
            for item in correction["files"]:
                if sha256(qemu / item["file"]) != item["afterSha256"]:
                    raise ValueError("Corrected QEMU source differs from its declared identity: " + item["file"])
            report["qemuSourceCorrections"].append(dict(correction, application="checked exact original and resulting source before configure/compile"))
        save()
'''.encode()
            data = replace_once(data, anchor, correction, "Checked pre-compile source correction")
            data = replace_once(data,
                b'        report["compilerSourcesUnchangedDuringBuild"] = True\n',
                b'        report["compilerSourcesUnchangedDuringBuild"] = True\n'
                b'        for correction in report["qemuSourceCorrections"]:\n'
                b'            for item in correction["files"]:\n'
                b'                if sha256(qemu / item["file"]) != item["afterSha256"]:\n'
                b'                    raise ValueError("Corrected QEMU source changed during compilation")\n'
                b'            correction["unchangedAtCompletion"] = True\n'
                b'        correction = LOCK["libffiSourceCorrection"]\n'
                b'        if sha256(source / "libffi" / correction["file"]) != correction["afterSha256"]:\n'
                b'            raise ValueError("Corrected libffi source changed during QEMU compilation")\n'
                b'        report["libffiSourceCorrection"]["unchangedAtCompletion"] = True\n',
                "Completion source identity")
        elif name == "runtime_build_support.py":
            data = replace_once(data, f'RUNTIME_COMPATIBILITY = "{S1_RUNTIME}"'.encode(),
                                f'RUNTIME_COMPATIBILITY = "{SERVER_RUNTIME}"'.encode(), "Private build identity")
        elif name == "inputs.lock.json":
            lock = json.loads(data)
            if lock["candidateRuntimeCompatibility"] != S1_RUNTIME:
                raise ValueError("S2 V3 derivation requires the exact S1 V3 input contract")
            lock["candidateRuntimeCompatibility"] = SERVER_RUNTIME
            lock["machineBuildProfile"] = {"id": "server-v3", "reservedWasmMiB": SERVER_WASM_MIB,
                "guestMemoryMiB": 2048, "virtualCpus": 2, "sourceRecipeRuntimeCompatibility": S1_RUNTIME,
                "memoryLayout": "split-2x1024m-ram-blocks-v1"}
            lock["qemuSourceCorrections"] = CORRECTIONS
            lock["libffiSourceCorrection"] = LIBFFI_CORRECTION
            data = (json.dumps(lock, indent=2) + "\n").encode()
        outputs[name] = data
    manifest = {"schema": "terrarium.qemu-machine-recipe/v1", "runtimeCompatibility": SERVER_RUNTIME,
        "hardwareTarget": {"guestMemoryMiB": 2048, "virtualCpus": 2, "reservedWasmMiB": SERVER_WASM_MIB, "translationCacheMiB": 500},
        "qemuSourceCorrections": CORRECTIONS, "libffiSourceCorrection": LIBFFI_CORRECTION,
        "derivation": "Exact source patch and recipe inputs before a fresh compile; no reused or rewritten binary artifacts.",
        "wrapper": {"file": "build-machine-runtime-v3.py", "sha256": sha256(Path(__file__).read_bytes())},
        "inputs": inputs, "outputs": {name: {"bytes": len(data), "sha256": sha256(data)} for name, data in outputs.items()}}
    outputs["machine-recipe.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
    if destination.exists() and any(destination.iterdir()):
        actual = {str(path.relative_to(destination)) for path in destination.rglob("*") if path.is_file()}
        if actual != set(outputs):
            raise ValueError("Existing derived recipe contains different or unexpected files; preserve it and select another directory")
        for name, data in outputs.items():
            if (destination / name).read_bytes() != data:
                raise ValueError("Existing derived recipe changed: " + name)
    else:
        destination.mkdir(parents=True, exist_ok=True)
        for name, data in outputs.items():
            path = destination / name
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("xb") as stream:
                stream.write(data)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__, add_help=False)
    parser.add_argument("--derived-recipe-dir", type=Path, required=True)
    parser.add_argument("--derive-only", action="store_true")
    args, build_args = parser.parse_known_args()
    destination = args.derived_recipe_dir.resolve()
    if destination == RECIPE or RECIPE in destination.parents:
        parser.error("Derived recipes must be retained outside the source recipe directory")
    manifest = derive_recipe(RECIPE, destination)
    print("QEMU_MACHINE_RECIPE_DERIVED " + json.dumps({"directory": str(destination), "runtimeCompatibility": manifest["runtimeCompatibility"],
        "manifestSha256": sha256((destination / "machine-recipe.json").read_bytes())}), flush=True)
    if args.derive_only:
        if build_args:
            parser.error("--derive-only does not accept build arguments")
        return
    if not build_args:
        parser.error("Supply bounded build-runtime.py arguments or --derive-only")
    completed = subprocess.run([sys.executable, "-B", str(destination / "build-runtime.py"), *build_args])
    raise SystemExit(completed.returncode)


if __name__ == "__main__":
    main()
