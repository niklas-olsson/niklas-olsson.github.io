#!/usr/bin/env python3
"""Derive and run the fixed S2 server recipe without replacing S1's build recipe.

This changes source recipe inputs before compilation. It never edits Wasm or
relinks artifacts from a qualified build. The underlying owned build retains its
fresh private compiler/cache, complete source identities and bounded stages.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

RECIPE = Path(__file__).resolve().parent
SERVER_RUNTIME = "qemu@8.2.0-terrarium-0ef7b4e-s2-server-v1"
SERVER_WASM_MIB = 3584
S1_RUNTIME = "qemu@8.2.0-terrarium-0ef7b4e-s1-candidate-v3"
FILES = ("build-runtime.py", "runtime_build_support.py", "inputs.lock.json",
         "patches/glib-stable-runtime-paths.patch", "patches/emscripten-proxy-context-lifetime.patch")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def replace_once(data: bytes, old: bytes, new: bytes, label: str) -> bytes:
    if data.count(old) != 1:
        raise ValueError(f"{label}: expected exactly one declared S1 recipe site")
    return data.replace(old, new)


def derive_recipe(source: Path, destination: Path) -> dict:
    outputs = {}
    inputs = {}
    for name in FILES:
        data = (source / name).read_bytes()
        inputs[name] = {"bytes": len(data), "sha256": sha256(data)}
        if name == "build-runtime.py":
            data = replace_once(data, b"-sTOTAL_MEMORY=2300MB", b"-sTOTAL_MEMORY=3584MB", "Fixed server Wasm reservation")
            data = replace_once(data, b"The corrected recipe requires its distinct candidate-v3 runtime identity",
                                b"The derived server recipe requires its distinct s2-server-v1 runtime identity", "Recipe identity diagnostic")
        elif name == "runtime_build_support.py":
            data = replace_once(data, f'RUNTIME_COMPATIBILITY = "{S1_RUNTIME}"'.encode(),
                                f'RUNTIME_COMPATIBILITY = "{SERVER_RUNTIME}"'.encode(), "Private build compatibility identity")
        elif name == "inputs.lock.json":
            lock = json.loads(data)
            if lock["candidateRuntimeCompatibility"] != S1_RUNTIME:
                raise ValueError("S2 server derivation requires the exact S1 V3 input contract")
            lock["candidateRuntimeCompatibility"] = SERVER_RUNTIME
            lock["machineBuildProfile"] = {"id": "server-v1", "reservedWasmMiB": SERVER_WASM_MIB,
                                            "guestMemoryMiB": 2048, "virtualCpus": 2,
                                            "sourceRecipeRuntimeCompatibility": S1_RUNTIME}
            data = (json.dumps(lock, indent=2) + "\n").encode()
        outputs[name] = data
    manifest = {"schema": "terrarium.qemu-machine-recipe/v1", "runtimeCompatibility": SERVER_RUNTIME,
                "hardwareTarget": {"guestMemoryMiB": 2048, "virtualCpus": 2, "reservedWasmMiB": SERVER_WASM_MIB,
                                   "translationCacheMiB": 500},
                "derivation": "Source recipe and compatibility identity changes before a fresh compile; no patched or reused binary artifacts.",
                "wrapper": {"file": "build-machine-runtime.py", "sha256": sha256(Path(__file__).read_bytes())},
                "inputs": inputs,
                "outputs": {name: {"bytes": len(data), "sha256": sha256(data)} for name, data in outputs.items()}}
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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, add_help=False)
    parser.add_argument("--derived-recipe-dir", type=Path, required=True)
    parser.add_argument("--derive-only", action="store_true")
    args, build_args = parser.parse_known_args()
    destination = args.derived_recipe_dir.resolve()
    if destination == RECIPE or RECIPE in destination.parents:
        parser.error("Derived recipes must be retained outside the source recipe directory")
    manifest = derive_recipe(RECIPE, destination)
    print("QEMU_MACHINE_RECIPE_DERIVED " + json.dumps({"directory": str(destination),
          "runtimeCompatibility": manifest["runtimeCompatibility"],
          "manifestSha256": sha256((destination / "machine-recipe.json").read_bytes())}), flush=True)
    if args.derive_only:
        if build_args:
            parser.error("--derive-only does not accept runtime build arguments")
        return
    if not build_args:
        parser.error("Supply the bounded build-runtime.py arguments or --derive-only")
    command = [sys.executable, "-B", str(destination / "build-runtime.py"), *build_args]
    completed = subprocess.run(command)
    raise SystemExit(completed.returncode)


if __name__ == "__main__":
    main()
