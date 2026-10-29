#!/usr/bin/env python3
"""Install verified QEMU build tools into a fresh workspace, without system writes."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import time


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--jobs", type=int, default=4)
    args = parser.parse_args()
    if not 1 <= args.jobs <= 16:
        parser.error("--jobs must be between 1 and 16")
    root = args.work_dir.resolve()
    if root.exists() and any(root.iterdir()):
        parser.error("--work-dir must be empty")
    root.mkdir(parents=True, exist_ok=True)
    cache = args.cache_dir.resolve()
    lock = json.loads(Path(__file__).with_name("inputs.lock.json").read_text())
    inputs = {item["file"]: item for item in lock["inputs"]}
    temporary = root / "tmp"
    temporary.mkdir()
    logs = root / "logs"
    logs.mkdir()
    host = root / "host"
    env = {**os.environ, "PATH": str(host / "bin") + ":" + os.environ["PATH"], "TMPDIR": str(temporary)}
    report = {"schema": "terrarium.qemu-tool-bootstrap/v1", "status": "running",
              "recipeSha256": sha256(Path(__file__)),
              "inputLockSha256": sha256(Path(__file__).with_name("inputs.lock.json")),
              "command": [sys.executable, *sys.argv], "jobs": args.jobs,
              "pythonVersion": sys.version, "pid": os.getpid(), "steps": []}

    def save():
        (root / "bootstrap-result.json").write_text(json.dumps(report, indent=2) + "\n")

    save()

    def verify(name):
        path = cache / name
        if path.stat().st_size != inputs[name]["bytes"] or sha256(path) != inputs[name]["sha256"]:
            raise ValueError(f"Pinned input mismatch: {name}")
        return path

    def unpack(name, destination):
        destination.mkdir(parents=True, exist_ok=True)
        with tarfile.open(verify(name)) as archive:
            for member in archive.getmembers():
                parts = Path(member.name).parts
                if len(parts) < 2:
                    continue
                member.name = "/".join(parts[1:])
                # data_filter drops archive uid/gid, avoiding inaccessible UID-1000 compiler trees.
                archive.extract(member, destination, filter="data")

    def run(name, command, cwd):
        log = logs / f"{name}.log"
        step = {"name": name, "command": [str(x) for x in command], "cwd": str(cwd),
                "log": str(log.relative_to(root)), "exitCode": None}
        report["steps"].append(step)
        save()
        started = time.monotonic()
        with log.open("w") as output:
            output.write("$ " + " ".join(str(x) for x in command) + "\n")
            output.flush()
            result = subprocess.run(command, cwd=cwd, env=env, stdout=output, stderr=subprocess.STDOUT)
        step.update(exitCode=result.returncode, seconds=round(time.monotonic() - started, 3), logSha256=sha256(log))
        if result.returncode:
            report.update(status="failed", error=f"{name} returned {result.returncode}")
        save()
        result.check_returncode()
        print(f"completed {name}", flush=True)

    sdk = root / "sdk"
    unpack("emsdk.tar.gz", sdk)
    unpack("2ce4170cef5ce46f337f9fd907b614a8db772c7d-wasm-binaries.tar.xz", sdk / "upstream")
    unpack("node-v16.20.0-linux-x64.tar.xz", sdk / "node/16.20.0_64bit")
    # These are the SDK's local installation records for the verified archives above.
    # They do not attest compilation; the subsequent compiler check validates version/revision.
    (sdk / "upstream/.emsdk_version").write_text("releases-2ce4170cef5ce46f337f9fd907b614a8db772c7d-64bit\n")
    (sdk / "node/16.20.0_64bit/.emsdk_version").write_text("node-16.20.0-64bit\n")
    (sdk / "upstream/emscripten/emscripten-version.txt").write_text('"3.1.50"\n')
    run("activate-sdk", [sys.executable, "emsdk.py", "activate", "3.1.50"], sdk)
    wheels = [str(verify(name)) for name in inputs if name.endswith(".whl")]
    run("install-python-tools", [sys.executable, "-m", "pip", "install", "--no-index", "--no-deps",
                                "--disable-pip-version-check", "--target", str(root / "python-tools"), *wheels], root)
    for name in ["m4", "autoconf", "automake", "libtool", "pkgconf"]:
        source = root / "source" / name
        unpack(name + ".tar.xz", source)
        run(name + "-configure", ["./configure", f"--prefix={host}"], source)
        run(name + "-build", ["make", f"-j{args.jobs}"], source)
        run(name + "-install", ["make", "install"], source)
    (host / "bin/pkg-config").symlink_to("pkgconf")
    source = root / "source/e2fsprogs"
    unpack("e2fsprogs.tar.xz", source)
    run("e2fsprogs-configure", ["./configure", f"--prefix={host}", "--disable-nls", "--disable-fsck", "--disable-uuidd",
                              "--without-crond-dir", "--without-udev-rules-dir", "--without-systemd-unit-dir"], source)
    run("e2fsprogs-build", ["make", f"-j{args.jobs}"], source)
    run("e2fsprogs-install", ["make", "install"], source)
    report.update(sdkDir=str(sdk), hostToolsDir=str(host), pythonToolsDir=str(root / "python-tools"), status="installed")
    save()
    print(json.dumps({"sdkDir": str(sdk), "hostToolsDir": str(host),
                      "pythonToolsDir": str(root / "python-tools"), "status": "installed"}, indent=2))


if __name__ == "__main__":
    main()
