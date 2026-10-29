#!/usr/bin/env python3
"""Build the pinned candidate runtime in a new work directory. No application assets are replaced."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import time
import zipfile

RECIPE = Path(__file__).resolve().parent
LOCK = json.loads((RECIPE / "inputs.lock.json").read_text())


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(part)
    return h.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--sdk-dir", type=Path, required=True)
    parser.add_argument("--host-tools-dir", type=Path)
    parser.add_argument("--python-tools-dir", type=Path)
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--resume-qemu", action="store_true", help="Reuse completed dependency builds; this is not a clean rebuild")
    args = parser.parse_args()
    if not 1 <= args.jobs <= 16:
        parser.error("--jobs must be between 1 and 16")
    work = args.work_dir.resolve()
    if work.exists() and any(work.iterdir()) and not args.resume_qemu:
        parser.error("--work-dir must be empty. Use another directory for a clean build.")
    work.mkdir(parents=True, exist_ok=True)
    cache = args.cache_dir.resolve()
    sdk = args.sdk_dir.resolve()
    source = work / "source"
    target = work / "target"
    logs = work / "logs"
    temporary = work / "tmp"
    previous = None
    if args.resume_qemu:
        previous = json.loads((work / "build-result.json").read_text())
        previous_lock = json.loads((work / "inputs.lock.json").read_text())
        if previous["recipeSha256"] != sha256(Path(__file__)) or previous["runtimeCompatibility"] != LOCK["candidateRuntimeCompatibility"]:
            raise ValueError("Cannot reuse dependencies after changing the build recipe or runtime identity; start a clean build")
        if previous.get("patches") != {"glib-stable-runtime-paths.patch": sha256(RECIPE / "patches/glib-stable-runtime-paths.patch")}:
            raise ValueError("Cannot reuse dependencies after changing source patches; start a clean build")
        if sha256(work / "inputs.lock.json") != previous["inputLockSha256"]:
            raise ValueError("Previous build input snapshot does not match its report")
        current_by_name = {item["file"]: item for item in LOCK["inputs"]}
        if any(current_by_name.get(item["file"]) != item for item in previous_lock["inputs"]):
            raise ValueError("Cannot reuse dependencies after changing their pinned inputs")
        if any(not any(step["name"] == name and step.get("exitCode") == 0 for step in previous["steps"])
               for name in ["zlib-install", "ffi-install", "glib-build", "glib-install", "pixman-build", "pixman-install"]):
            raise ValueError("Cannot resume QEMU before all dependency builds passed")
        suffix = len(list(work.glob("build-result.previous-*.json"))) + 1
        shutil.copyfile(work / "build-result.json", work / f"build-result.previous-{suffix}.json")
        shutil.copyfile(work / "inputs.lock.json", work / f"inputs.previous-{suffix}.json")
    for folder in (source, target, logs, temporary):
        folder.mkdir(exist_ok=args.resume_qemu)
    (work / "inputs.lock.json").write_text(json.dumps(LOCK, indent=2) + "\n")
    env = dict(os.environ)
    paths = [str(sdk / "upstream/emscripten"), str(sdk / "node/16.20.0_64bit/bin")]
    if args.host_tools_dir:
        paths.append(str(args.host_tools_dir.resolve() / "bin"))
    if args.python_tools_dir:
        python_tools = args.python_tools_dir.resolve()
        paths.append(str(python_tools / "bin"))
        env["PYTHONPATH"] = str(python_tools)
    env.update(PATH=":".join(paths) + ":" + os.environ["PATH"], TMPDIR=str(temporary),
               EM_CONFIG=str(sdk / ".emscripten"),
               EM_CACHE=str(work / "emscripten-cache"),
               SOURCE_DATE_EPOCH="1700000000", TZ="UTC", LC_ALL="C", PYTHONHASHSEED="0",
               PKG_CONFIG_PATH=str(target / "lib/pkgconfig"),
               EM_PKG_CONFIG_PATH=str(target / "lib/pkgconfig"),
               CPATH=str(target / "include"), CHOST="wasm32-unknown-linux")
    results = []
    report = {"schema": "terrarium.qemu-build-result/v1", "status": "running",
              "sourceRevision": LOCK["sourceRevision"],
              "runtimeCompatibility": LOCK["candidateRuntimeCompatibility"],
              "inputLockSha256": sha256(work / "inputs.lock.json"),
              "recipeSha256": sha256(Path(__file__)), "sourceDateEpoch": env["SOURCE_DATE_EPOCH"],
              "patches": {"glib-stable-runtime-paths.patch": sha256(RECIPE / "patches/glib-stable-runtime-paths.patch")},
              "pid": os.getpid(), "buildMode": "resumed-qemu" if args.resume_qemu else "clean",
              "buildHost": {"system": platform.system(), "machine": platform.machine(),
                            "release": platform.release(), "pythonVersion": sys.version},
              "toolchainExecutables": {},
              "jobs": args.jobs, "steps": results, "artifacts": [],
              "limitations": ["Candidate build output is not qualified for application use.",
                              "No guest-image or bit-reproducibility claim follows from one runtime build."]}

    def save():
        (work / "build-result.json").write_text(json.dumps(report, indent=2) + "\n")

    def run(label, command, cwd, extra=None):
        if previous is not None and not label.startswith("qemu-"):
            original = next(step for step in previous["steps"] if step["name"] == label)
            if original.get("exitCode") != 0:
                raise ValueError(f"Cannot reuse failed dependency stage {label}")
            results.append({**original, "reusedFromPreviousAttempt": True})
            save()
            return
        attempt = f"-resume-{suffix}" if previous is not None else ""
        log = logs / f"{len(results):02}-{label}{attempt}.log"
        start = time.monotonic()
        item = {"name": label, "command": [str(x) for x in command], "cwd": str(cwd),
                "log": str(log.relative_to(work)), "exitCode": None}
        results.append(item)
        save()
        with log.open("w") as output:
            output.write("$ " + " ".join(str(x) for x in command) + "\n")
            output.flush()
            result = subprocess.run(command, cwd=cwd, env={**env, **(extra or {})},
                                    stdout=output, stderr=subprocess.STDOUT)
        item.update(exitCode=result.returncode, seconds=round(time.monotonic() - start, 3), logSha256=sha256(log))
        save()
        print(f"{label}: exit={result.returncode} ({item['seconds']}s), {log}", flush=True)
        if result.returncode:
            raise RuntimeError(f"{label} failed; inspect {log}")

    def unpack(filename, directory):
        item = next(x for x in LOCK["inputs"] if x["file"] == filename)
        archive = cache / filename
        if archive.stat().st_size != item["bytes"] or sha256(archive) != item["sha256"]:
            raise ValueError(f"Pinned input mismatch: {archive}")
        directory.mkdir(parents=True, exist_ok=True)
        with tarfile.open(archive) as stream:
            for member in stream.getmembers():
                parts = Path(member.name).parts
                if len(parts) < 2:
                    continue
                member.name = "/".join(parts[1:])
                stream.extract(member, directory, filter="data")

    try:
        if previous is None:
            # Each build starts with a private copy of the provided compiler's standard-library cache.
            # Subsequent cache generation cannot leak from one clean build into the other.
            compiler_cache = sdk / "upstream/emscripten/cache"
            cache_identity = hashlib.sha256()
            cache_files = 0
            for path in sorted(compiler_cache.rglob("*")):
                if path.is_file():
                    cache_identity.update((str(path.relative_to(compiler_cache)) + "\0" + str(path.stat().st_size) + "\0" + sha256(path) + "\n").encode())
                    cache_files += 1
            shutil.copytree(compiler_cache, work / "emscripten-cache")
            report["compilerCacheBasis"] = {"mode": "private copy of supplied SDK standard-library cache",
                                           "fileCount": cache_files, "treeSha256": cache_identity.hexdigest()}
        else:
            report["compilerCacheBasis"] = previous["compilerCacheBasis"]
        for name in ["emcc", "clang", "wasm-ld", "node", "gcc", "make", "patch", "m4", "autoconf", "automake", "libtool", "pkg-config", "meson", "ninja"]:
            executable = (sdk / "upstream/bin" / name) if name in ["clang", "wasm-ld"] else shutil.which(name, path=env["PATH"])
            if executable is None or not Path(executable).is_file():
                raise ValueError(f"Missing build prerequisite: {name}")
            executable = Path(executable).resolve()
            report["toolchainExecutables"][name] = {"path": str(executable), "sha256": sha256(executable)}
        report["nativeCompilerVersion"] = subprocess.check_output(["gcc", "--version"], env=env, text=True).splitlines()[0]
        version = subprocess.check_output([str(sdk / "upstream/emscripten/emcc"), "--version"], env=env, text=True)
        if "3.1.50" not in version or LOCK["emscriptenRevision"] not in version:
            raise ValueError("Compiler version/revision does not match the input lock")
        report["compilerVersion"] = version.strip()
        # Fail before expensive dependency builds if QEMU cannot create its Python environment.
        python_check = subprocess.check_output([sys.executable, "-c",
            "import json,importlib.metadata as m; import distlib,venv,tomllib; "
            "print(json.dumps({n:m.version(n) for n in ['distlib','meson','ninja','packaging']}))"], env=env, text=True)
        python_versions = json.loads(python_check)
        expected_python = {"distlib": "0.3.9", "meson": "1.5.0", "ninja": "1.11.1.1", "packaging": "24.2"}
        if python_versions != expected_python:
            raise ValueError(f"Python build tools differ from pinned versions: {python_versions}")
        report["pythonPackages"] = python_versions
        for tool, expected in [("meson", "1.5.0"), ("ninja", "1.11.1")]:
            found = subprocess.check_output([tool, "--version"], env=env, text=True).strip()
            if not found.startswith(expected):
                raise ValueError(f"Expected {tool} {expected}, found {found}")
            report[tool + "Version"] = found
        flags = "-O2 -matomics -mbulk-memory -DNDEBUG -sWASM_BIGINT -DWASM_BIGINT -pthread -sMALLOC=emmalloc -sASYNCIFY=1"
        env.update(CFLAGS=flags, CXXFLAGS=flags, LDFLAGS=f"-L{target}/lib -O2")
        for name, archive in [("zlib", "zlib.tar.gz"), ("libffi", "libffi.tar.gz"),
                              ("glib", "glib.tar.xz"), ("pixman", "pixman.tar.gz"),
                              ("qemu", "qemu-wasm.tar.gz"), ("xterm-pty", "xterm-pty.tgz")]:
            if previous is None or name == "qemu":
                unpack(archive, source / name)
        run("zlib-configure", ["emconfigure", "./configure", f"--prefix={target}", "--static"], source / "zlib")
        run("zlib-install", ["make", f"-j{args.jobs}", "install"], source / "zlib")
        run("ffi-autoreconf", ["autoreconf", "-fiv"], source / "libffi")
        run("ffi-configure", ["emconfigure", "./configure", "--host=wasm32-unknown-linux", f"--prefix={target}",
                              "--enable-static", "--disable-shared", "--disable-dependency-tracking", "--disable-builddir",
                              "--disable-multi-os-directory", "--disable-raw-api", "--disable-structs", "--disable-docs"],
            source / "libffi", {"LDFLAGS": env["LDFLAGS"] + " -sEXPORTED_RUNTIME_METHODS=getTempRet0,setTempRet0"})
        run("ffi-install", ["emmake", "make", f"-j{args.jobs}", "install", "SUBDIRS=include"], source / "libffi")
        stub = source / "res_query.c"
        stub.write_text("#include <netdb.h>\nint res_query(const char *n,int c,int t,unsigned char *d,int l){h_errno=HOST_NOT_FOUND;return -1;}\n")
        run("resolver-stub", ["emcc", *flags.split(), "-fPIC", "-c", str(stub), "-o", str(source / "resolv.o")], source)
        run("resolver-archive", ["emar", "rcs", str(target / "lib/libresolv.a"), str(source / "resolv.o")], source)
        glib = source / "glib"
        run("glib-stable-runtime-paths", ["patch", "--batch", "--forward", "-p1", "-i", str(RECIPE / "patches/glib-stable-runtime-paths.patch")], glib)
        unpack("gvdb.tar.gz", glib / "subprojects/gvdb")
        unpack("pcre2.tar.bz2", glib / "subprojects/pcre2-10.40")
        patch_item = next(x for x in LOCK["inputs"] if x["file"] == "pcre2-patch.zip")
        patch_path = cache / "pcre2-patch.zip"
        if sha256(patch_path) != patch_item["sha256"]:
            raise ValueError("PCRE2 build patch hash mismatch")
        with zipfile.ZipFile(patch_path) as archive:
            for name in archive.namelist():
                if Path(name).is_absolute() or ".." in Path(name).parts:
                    raise ValueError("Unsafe PCRE2 patch path")
            archive.extractall(glib / "subprojects")
        wrapper = source / "emcc-meson-wrap.sh"
        wrapper.write_text('#!/usr/bin/env bash\nset -euo pipefail\ncmd="$1"; shift\nargs=()\nfor arg in "$@"; do args+=("${arg//-Werror=unused-command-line-argument/-Wno-error=unused-command-line-argument}"); done\nexec "$cmd" "${args[@]}"\n')
        cross = source / "cross.meson"
        cross.write_text(f"[host_machine]\nsystem='emscripten'\ncpu_family='wasm32'\ncpu='wasm32'\nendian='little'\n[binaries]\nc=['bash','{wrapper}','emcc']\ncpp=['bash','{wrapper}','em++']\nar='emar'\nranlib='emranlib'\npkgconfig=['pkg-config','--static']\n")
        glibflags = "-Wno-error=incompatible-function-pointer-types -Wincompatible-function-pointer-types " + flags
        env.update(CFLAGS=glibflags, CXXFLAGS=glibflags)
        run("glib-configure", ["meson", "setup", "_build", f"--prefix={target}", f"--cross-file={cross}",
                              "--wrap-mode=nodownload", "--default-library=static", "--buildtype=release",
                              "--force-fallback-for=pcre2,gvdb", "-Dselinux=disabled", "-Dxattr=false", "-Dlibmount=disabled",
                              "-Dnls=disabled", "-Dtests=false", "-Dglib_assert=false", "-Dglib_checks=false"], glib)
        config = glib / "_build/config.h"
        removed = {f"#define {name} 1" for name in ["HAVE_CLOSE_RANGE", "HAVE_EPOLL_CREATE", "HAVE_KQUEUE", "HAVE_POSIX_SPAWN", "HAVE_FALLOCATE"]}
        config.write_text("\n".join(line for line in config.read_text().splitlines() if line not in removed) + "\n")
        run("glib-build", ["ninja", "-C", "_build", f"-j{args.jobs}"], glib)
        run("glib-install", ["meson", "install", "-C", "_build", "--no-rebuild"], glib)
        env.update(CFLAGS=flags, CXXFLAGS=flags)
        run("pixman-configure", ["emconfigure", "./configure", f"--prefix={target}", "--disable-shared", "--enable-static", "--disable-gtk"], source / "pixman")
        run("pixman-build", ["emmake", "make", f"-j{args.jobs}"], source / "pixman")
        run("pixman-install", ["emmake", "make", "install"], source / "pixman")
        qemu = source / "qemu"
        unpack("keycodemapdb.tar.gz", qemu / "subprojects/keycodemapdb")
        unpack("dtc.tar.gz", qemu / "subprojects/dtc")
        for name in ["berkeley-softfloat-3", "berkeley-testfloat-3"]:
            unpack(name + ".tar.gz", qemu / "subprojects" / name)
            shutil.copytree(qemu / "subprojects/packagefiles" / name, qemu / "subprojects" / name, dirs_exist_ok=True)
        obj = work / "qemu-build"
        obj.mkdir(exist_ok=args.resume_qemu)
        qflags = (f"-O3 -g0 -ffile-prefix-map={work}=. -Wno-error=unused-command-line-argument -matomics -mbulk-memory "
                  "-DNDEBUG -DG_DISABLE_ASSERT -D_GNU_SOURCE -sLZ4=1 -sASYNCIFY=1 -pthread -sPROXY_TO_PTHREAD=1 "
                  "-sFORCE_FILESYSTEM -sALLOW_TABLE_GROWTH -sTOTAL_MEMORY=2300MB -sWASM_BIGINT -sMALLOC=emmalloc "
                  f"--js-library={source}/xterm-pty/emscripten-pty.js -sEXPORT_ES6=1 -sASYNCIFY_IMPORTS=ffi_call_js")
        report["qemuCompileFlags"] = qflags
        run("qemu-configure", ["emconfigure", str(qemu / "configure"), "--static", "--target-list=x86_64-softmmu",
                              "--cpu=wasm32", "--cross-prefix=", "--without-default-features", "--enable-system",
                              "--with-coroutine=fiber", "--enable-virtfs", "--disable-docs", "--disable-werror",
                              "--disable-download", "--enable-fdt=internal",
                              f"--extra-cflags={qflags}", f"--extra-cxxflags={qflags}",
                              "--extra-ldflags=-sEXPORTED_RUNTIME_METHODS=getTempRet0,setTempRet0,addFunction,removeFunction,TTY,FS"], obj)
        run("qemu-build", ["emmake", "make", f"-j{args.jobs}", "qemu-system-x86_64"], obj)
        output = work / "artifacts"
        output.mkdir()
        for source_name, output_name in [("qemu-system-x86_64", "out.js"), ("qemu-system-x86_64.wasm", "qemu-system-x86_64.wasm"),
                                         ("qemu-system-x86_64.worker.js", "qemu-system-x86_64.worker.js")]:
            destination = output / output_name
            shutil.copyfile(obj / source_name, destination)
            report["artifacts"].append({"file": output_name, "bytes": destination.stat().st_size, "sha256": sha256(destination)})
        report["status"] = "built-unqualified"
        save()
        print(f"Built candidate artifacts: {output}. Application qualification remains required.")
    except Exception as exc:
        report.update(status="failed", error=str(exc))
        save()
        raise


if __name__ == "__main__":
    main()
