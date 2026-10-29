#!/usr/bin/env python3
"""Verify two independent build outputs and compare artifact bytes and declared inputs."""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
from pathlib import Path
import sys


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def toolchain_identity(build):
    """Keep observed paths, except the independently copied private emcc entry point.

    Its complete source tree, patch and executable hash are compared separately.
    Build-specific directories cannot themselves be reproducibility inputs.
    """
    identity = copy.deepcopy(build.get("toolchainExecutables"))
    isolation = build.get("compilerIsolation")
    if isolation is not None:
        private = Path(isolation["privateSource"])
        if not private.is_absolute() or Path(identity["emcc"]["path"]) != private / "emcc":
            raise ValueError("Private compiler path is not bound to the declared isolated source")
        identity["emcc"]["path"] = "<private-compiler-source>/emcc"
    return identity


def compiler_source_identity(build):
    isolation = build.get("compilerIsolation")
    if isolation is None:
        return None
    if isolation.get("cacheInitialFileCount") != 0 or not build.get("compilerSourcesUnchangedDuringBuild"):
        raise ValueError("Private compiler build lacks an empty cache or unchanged source completion proof")
    patch = isolation["patch"]
    return {"originalTreeSha256": isolation["originalTree"]["treeSha256"],
            "patchedTreeSha256": isolation["patchedTree"]["treeSha256"],
            "upstreamCommit": patch["upstreamCommit"], "patchSha256": patch["patchSha256"],
            "inputSha256": patch["inputSha256"], "outputSha256": patch["outputSha256"]}


def compiler_environment_identity(build):
    isolation = build.get("compilerIsolation")
    if isolation is None:
        return None
    private = Path(isolation["privateSource"])
    work = private.parent.parent
    if private != work / "compiler/emscripten":
        raise ValueError("Unexpected private compiler source role")
    controls = copy.deepcopy(build["compilerControlEnvironment"])
    roles = {"EM_CONFIG": "compiler/emscripten.config.py", "EM_CACHE": "emscripten-cache",
             "TMPDIR": "tmp", "PYTHONPYCACHEPREFIX": "python-bytecode", "CPATH": "target/include",
             "PKG_CONFIG_PATH": "target/lib/pkgconfig", "EM_PKG_CONFIG_PATH": "target/lib/pkgconfig"}
    for key, role in roles.items():
        if controls.get(key) != str(work / role):
            raise ValueError("Unbound private compiler environment role: " + key)
        controls[key] = "<build>/" + role
    paths = controls["PATH"].split(":")
    if paths[0] != str(private):
        raise ValueError("Private compiler is not the first declared PATH entry")
    controls["PATH"] = ":".join(["<build>/compiler/emscripten", *paths[1:]])
    effective = copy.deepcopy(build["effectiveCompilerConfiguration"]["effective"])
    for key, role in {"EM_CONFIG": "compiler/emscripten.config.py", "CACHE": "emscripten-cache", "PORTS": "emscripten-cache/ports"}.items():
        if effective.get(key) != str(work / role):
            raise ValueError("Unbound effective private compiler configuration role: " + key)
        effective[key] = "<build>/" + role
    return {"controlledEnvironment": controls, "effectiveConfiguration": effective}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--left", type=Path, required=True)
    parser.add_argument("--right", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.left.resolve().parent == args.right.resolve().parent:
        parser.error("Comparison requires two separate build directories")
    builds = [json.loads(p.read_text()) for p in [args.left, args.right]]
    if any(build["schema"] not in ["terrarium.qemu-build-result/v1", "terrarium.qemu-guest-build/v1", "terrarium.qemu-package-build/v1"] for build in builds):
        raise ValueError("Unsupported build report schema")
    if builds[0]["schema"] != builds[1]["schema"]:
        raise ValueError("Cannot compare different build types")
    for path, build in zip([args.left, args.right], builds):
        if build["status"] not in ["built-unqualified", "assembled-unqualified", "packaged-unqualified"] or not build["artifacts"]:
            raise ValueError(f"Build has no complete candidate outputs: {path}")
        for item in build["artifacts"]:
            if Path(item["file"]).name != item["file"]:
                raise ValueError("Unsafe artifact path")
            artifact = path.resolve().parent / "artifacts" / item["file"]
            if artifact.stat().st_size != item["bytes"] or digest(artifact) != item["sha256"]:
                raise ValueError(f"Artifact no longer matches its build record: {artifact}")
    keys = ["inputLockSha256", "guestInputLockSha256", "qemuInputLockSha256", "recipeSha256", "filesystemConfigSha256",
            "toolchainInputLockSha256", "sourceGuestManifestSha256", "sourceRootfsSha256", "patches",
            "runtimeCompatibility", "sourceRevision", "compilerVersion", "pythonPackages", "mke2fsExecutableSha256",
            "nativeCompilerVersion", "compilerCacheBasis", "guestToolInputLockSha256", "recipeIdentities", "pythonToolSourceIdentity", "externalBinaryToolIdentity",
            "moduleRecipeSha256", "moduleSupplementSha256", "inodeNormalizationSha256"]
    identities = {key: builds[0].get(key) == builds[1].get(key) for key in keys if key in builds[0] or key in builds[1]}
    identities["toolchainExecutables"] = toolchain_identity(builds[0]) == toolchain_identity(builds[1])
    identities["compilerSourceIdentity"] = compiler_source_identity(builds[0]) == compiler_source_identity(builds[1])
    identities["compilerEnvironmentIdentity"] = compiler_environment_identity(builds[0]) == compiler_environment_identity(builds[1])
    left = {item["file"]: item for item in builds[0]["artifacts"]}
    right = {item["file"]: item for item in builds[1]["artifacts"]}
    results = {name: left.get(name) == right.get(name) for name in sorted(left.keys() | right.keys())}
    clean = all(build["schema"] == "terrarium.qemu-guest-build/v1" or build.get("buildMode") == "clean" for build in builds)
    if any("compilerIsolation" in build for build in builds):
        clean = clean and all(build.get("freshWorkDirectory") is True and build.get("reusedOtherBuildObjects") is False for build in builds)
        clean = clean and bool(builds[0].get("buildId")) and builds[0]["buildId"] != builds[1].get("buildId")
    passed = clean and all(identities.values()) and all(results.values())
    report = {"schema": "terrarium.build-comparison/v1", "status": "identical" if passed else "not-proven",
              "leftReportSha256": digest(args.left), "rightReportSha256": digest(args.right),
              "left": str(args.left.resolve()), "right": str(args.right.resolve()),
              "bothClean": clean, "sameDeclaredInputs": identities, "artifactComparisons": results,
              "allArtifactBytesIdentical": all(results.values()),
              "limitations": ["This result covers these builds on their recorded environment only.",
                              "It does not qualify guest behavior, browser support, or checkpoint compatibility."]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    if not passed:
        sys.exit(1)


if __name__ == "__main__":
    main()
