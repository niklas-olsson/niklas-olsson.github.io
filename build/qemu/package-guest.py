#!/usr/bin/env python3
"""LZ4-package an identified owned guest using pinned Emscripten; never execute preload JS."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def one_json(text, pattern, label):
    matches = re.findall(pattern, text, re.S)
    if len(matches) != 1:
        raise ValueError(f"Expected one {label} data declaration")
    return json.loads(matches[0])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--guest-dir", type=Path, required=True)
    parser.add_argument("--sdk-dir", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    args = parser.parse_args()
    root = args.work_dir.resolve()
    guest = args.guest_dir.resolve()
    sdk = args.sdk_dir.resolve()
    if root.exists() and any(root.iterdir()):
        parser.error("--work-dir must be empty")
    root.mkdir(parents=True, exist_ok=True)
    output = root / "artifacts"
    output.mkdir()
    temporary = root / "tmp"
    temporary.mkdir()
    lock_path = Path(__file__).with_name("inputs.lock.json")
    lock = json.loads(lock_path.read_text())
    manifest_path = guest / "alpine-packages.json"
    manifest = json.loads(manifest_path.read_text())
    if manifest["schema"] != "terrarium.qemu-packages/v1" or manifest["guest"]["rootBytes"] != 157286400:
        raise ValueError("This packager accepts the owned 150-MiB small guest only")
    for name in ["kernel", "initramfs", "rom", "rootfs"]:
        item = manifest["packages"][name]
        if Path(item["file"]).name != item["file"]:
            raise ValueError("Unsafe package path")
        path = guest / item["file"]
        if path.stat().st_size != item["bytes"] or digest(path) != item["sha256"]:
            raise ValueError(f"Guest package no longer matches its manifest: {name}")
    root_image = guest / "disk-rootfs.img"
    if digest(root_image) != manifest["packages"]["rootfs"]["sha256"]:
        raise ValueError("Root image differs from the identified uncompressed package")
    env = {**os.environ, "TMPDIR": str(temporary), "EM_CONFIG": str(sdk / ".emscripten"),
           "SOURCE_DATE_EPOCH": "1700000000", "TZ": "UTC", "LC_ALL": "C"}
    version = subprocess.check_output([str(sdk / "upstream/emscripten/emcc"), "--version"], env=env, text=True)
    if lock["emscriptenRevision"] not in version or "3.1.50" not in version:
        raise ValueError("Packager compiler version/revision differs from the input lock")
    report = {"schema": "terrarium.qemu-package-build/v1", "status": "packaging", "buildMode": "clean",
              "recipeSha256": digest(Path(__file__)), "toolchainInputLockSha256": digest(lock_path),
              "sourceGuestManifestSha256": digest(manifest_path), "sourceRootfsSha256": digest(root_image),
              "compilerVersion": version.strip(), "artifacts": [],
              "limitations": ["Transport packaging does not qualify guest execution or runtime compatibility.",
                              "Generated preload JavaScript is parsed as data only and never executed."]}
    result_path = root / "package-build-result.json"
    try:
        command = [sys.executable, str(sdk / "upstream/emscripten/tools/file_packager.py"),
                   "load-rootfs.data", "--lz4", "--preload", str(root_image) + "@/pack-rootfs/disk-rootfs.img"]
        report["command"] = command
        preload = root / "generated-preload.js"
        with preload.open("w") as stdout, (root / "packager.log").open("w") as stderr:
            subprocess.run(command, cwd=output, env=env, stdout=stdout, stderr=stderr, check=True)
        text = preload.read_text()
        metadata = one_json(text, r'loadPackage\((\{"files".*?\})\);', "package metadata")
        index = one_json(text, r'var compressedData = (\{.*?\})\s*;', "compressed index")
        packed = output / "load-rootfs.data"
        expected_metadata = {"files": [{"filename": "/pack-rootfs/disk-rootfs.img", "start": 0, "end": 157286400}],
                             "remote_package_size": packed.stat().st_size}
        if metadata != expected_metadata:
            raise ValueError("Unexpected generated root package metadata")
        if set(index) != {"data", "cachedOffset", "cachedIndexes", "cachedChunks", "offsets", "sizes", "successes"}:
            raise ValueError("Unexpected LZ4 index fields")
        if index["data"] is not None or index["cachedIndexes"] != [-1, -1] or index["cachedChunks"] != [None, None]:
            raise ValueError("Unexpected LZ4 cache declarations")
        chunks = 157286400 // 2048
        if any(len(index[k]) != chunks for k in ["offsets", "sizes", "successes"]):
            raise ValueError("Unexpected LZ4 chunk count")
        offset = 0
        for position, size, success in zip(index["offsets"], index["sizes"], index["successes"]):
            if position != offset or type(size) is not int or not 1 <= size <= 2072 or success not in [0, 1] or (success == 0 and size != 2048):
                raise ValueError("Invalid generated LZ4 chunk")
            offset += size
        if index["cachedOffset"] != offset or offset + 4096 != packed.stat().st_size:
            raise ValueError("LZ4 package/cache lengths differ")
        del index["data"]
        manifest["packages"]["rootfs"] = {"file": packed.name, "bytes": packed.stat().st_size,
            "sha256": digest(packed), "metadata": metadata, "compressedData": index}
        for name in ["kernel", "initramfs", "rom"]:
            shutil.copyfile(guest / manifest["packages"][name]["file"], output / manifest["packages"][name]["file"])
        (output / "alpine-packages.json").write_text(json.dumps(manifest, separators=(",", ":")) + "\n")
        for path in sorted(output.iterdir()):
            report["artifacts"].append({"file": path.name, "bytes": path.stat().st_size, "sha256": digest(path)})
        report.update(status="packaged-unqualified", compressedBytes=packed.stat().st_size, rawBytes=157286400)
        result_path.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({"status": report["status"], "compressedBytes": report["compressedBytes"], "artifacts": str(output)}))
    except Exception as exc:
        report.update(status="failed", error=str(exc))
        result_path.write_text(json.dumps(report, indent=2) + "\n")
        raise


if __name__ == "__main__":
    main()
