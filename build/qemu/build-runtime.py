#!/usr/bin/env python3
"""Build the pinned candidate runtime in a new work directory. No application assets are replaced."""
from __future__ import annotations

import argparse
import datetime
import json
import os
import platform
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tarfile
import time
import uuid
import zipfile

from runtime_build_support import (RUNTIME_COMPATIBILITY, enable_child_subreaper, execute_owned_process, prepare_private_compiler,
                                   sha256, stage_boundary,
                                   sanitized_build_environment, tree_identity,
                                   verify_stage_boundary, verify_tree, write_json)

RECIPE = Path(__file__).resolve().parent
LOCK = json.loads((RECIPE / "inputs.lock.json").read_text())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--sdk-dir", type=Path, required=True)
    parser.add_argument("--host-tools-dir", type=Path)
    parser.add_argument("--python-tools-dir", type=Path)
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--stage", choices=["all", "dependencies", "qemu"], default="all",
                        help="A fresh build may stop after dependencies and continue its verified QEMU stage")
    parser.add_argument("--command-timeout", type=int, default=720,
                        help="Per-command bound in seconds, from 60 through 720")
    parser.add_argument("--stage-timeout", type=int, default=720,
                        help="Per-stage elapsed command budget in seconds, from 60 through 750")
    parser.add_argument("--resume-qemu", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not 1 <= args.jobs <= 16:
        parser.error("--jobs must be between 1 and 16")
    if not 60 <= args.command_timeout <= 720:
        parser.error("--command-timeout must be between 60 and 720 seconds")
    if not 60 <= args.stage_timeout <= 750:
        parser.error("--stage-timeout must be between 60 and 750 seconds")
    if args.resume_qemu:
        parser.error("Historical --resume-qemu reuse cannot qualify a clean candidate. Use a fresh --stage dependencies build, then its verified --stage qemu continuation.")
    if LOCK["candidateRuntimeCompatibility"] != RUNTIME_COMPATIBILITY:
        parser.error("The corrected recipe requires its distinct candidate-v3 runtime identity")
    work = args.work_dir.resolve()
    continuing = args.stage == "qemu"
    if work.exists() and any(work.iterdir()) and not continuing:
        parser.error("--work-dir must be empty. Use another directory for a clean build.")
    if continuing and not (work / "build-result.json").is_file():
        parser.error("--stage qemu requires this build's completed dependency stage")
    work.mkdir(parents=True, exist_ok=True)
    cache = args.cache_dir.resolve()
    sdk = args.sdk_dir.resolve()
    source = work / "source"
    target = work / "target"
    logs = work / "logs"
    temporary = work / "tmp"
    configuration = {"sdkDir": str(sdk), "cacheDir": str(cache), "jobs": args.jobs,
                     "hostToolsDir": str(args.host_tools_dir.resolve()) if args.host_tools_dir else None,
                     "pythonToolsDir": str(args.python_tools_dir.resolve()) if args.python_tools_dir else None,
                     "commandTimeoutSeconds": args.command_timeout,
                     "stageTimeoutSeconds": args.stage_timeout,
                     "runtimeCompatibility": LOCK["candidateRuntimeCompatibility"]}
    recipe_identities = {str(p.relative_to(RECIPE)): sha256(p) for p in [
        Path(__file__), RECIPE / "runtime_build_support.py", RECIPE / "inputs.lock.json",
        RECIPE / "patches/glib-stable-runtime-paths.patch", RECIPE / "patches/emscripten-proxy-context-lifetime.patch"]}
    previous = json.loads((work / "build-result.json").read_text()) if continuing else None
    if continuing:
        boundary = json.loads((work / "stage-boundary.json").read_text())
        if previous.get("status") != "dependencies-complete" or previous.get("buildMode") != "clean":
            raise ValueError("Only a completed dependency stage from a fresh clean build may continue")
        if sha256(work / "build-result.json") != boundary.get("completedReportSha256"):
            raise ValueError("Completed dependency report changed")
        verify_stage_boundary(work, boundary, previous["buildId"], configuration, recipe_identities)
    for folder in (source, target, logs, temporary):
        folder.mkdir(exist_ok=continuing)
    if not continuing:
        (work / "inputs.lock.json").write_text(json.dumps(LOCK, indent=2) + "\n")
    env, removed_environment = sanitized_build_environment(os.environ)
    private_em = work / "compiler/emscripten"
    paths = [str(private_em), str(sdk / "node/16.20.0_64bit/bin")]
    if args.host_tools_dir:
        paths.append(str(args.host_tools_dir.resolve() / "bin"))
    if args.python_tools_dir:
        python_tools = args.python_tools_dir.resolve()
        paths.append(str(python_tools / "bin"))
        env["PYTHONPATH"] = str(python_tools)
    env.update(PATH=":".join(paths) + ":" + os.environ["PATH"], TMPDIR=str(temporary),
               EM_CONFIG=str(work / "compiler/emscripten.config.py"),
               EM_CACHE=str(work / "emscripten-cache"),
               EMSDK_PYTHON=sys.executable,
               SOURCE_DATE_EPOCH="1700000000", TZ="UTC", LC_ALL="C", PYTHONHASHSEED="0",
               PKG_CONFIG_PATH=str(target / "lib/pkgconfig"),
               EM_PKG_CONFIG_PATH=str(target / "lib/pkgconfig"),
               PYTHONDONTWRITEBYTECODE="1", PYTHONNOUSERSITE="1", PYTHONPYCACHEPREFIX=str(work / "python-bytecode"),
               EMCC_CORES=str(args.jobs), BINARYEN_CORES=str(args.jobs),
               CPATH=str(target / "include"), CHOST="wasm32-unknown-linux")
    results = previous["steps"] if continuing else []
    report = previous if continuing else {"schema": "terrarium.qemu-build-result/v1", "status": "running",
              "buildId": str(uuid.uuid4()), "configuration": configuration,
              "recipeIdentities": recipe_identities,
              "sourceRevision": LOCK["sourceRevision"],
              "runtimeCompatibility": LOCK["candidateRuntimeCompatibility"],
              "inputLockSha256": sha256(work / "inputs.lock.json"),
              "recipeSha256": sha256(Path(__file__)), "sourceDateEpoch": env["SOURCE_DATE_EPOCH"],
              "patches": {name: sha256(RECIPE / "patches" / name) for name in ["glib-stable-runtime-paths.patch", "emscripten-proxy-context-lifetime.patch"]},
              "pid": os.getpid(), "buildMode": "clean", "freshWorkDirectory": True,
              "reusedOtherBuildObjects": False, "stageInvocations": [],
              "environmentKeysRemoved": removed_environment,
              "buildHost": {"system": platform.system(), "machine": platform.machine(),
                            "release": platform.release(), "pythonVersion": sys.version},
              "toolchainExecutables": {},
              "jobs": args.jobs, "steps": results, "artifacts": [],
              "limitations": ["Candidate build output is not qualified for application use.",
                              "No guest-image or bit-reproducibility claim follows from one runtime build."]}

    invocation = {"requestedStage": args.stage, "pid": os.getpid(),
                  "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  "argv": [sys.executable, *sys.argv], "status": "running"}
    invocation["childSubreaper"] = enable_child_subreaper()
    invocation["environmentKeysRemoved"] = removed_environment
    report["stageInvocations"].append(invocation)
    report["status"] = "running"
    phase_deadline = time.monotonic() + args.stage_timeout

    def request_interruption(signum, _frame):
        invocation["interruptionSignal"] = signal.Signals(signum).name
        raise InterruptedError("Build stage interrupted by " + signal.Signals(signum).name)

    signal.signal(signal.SIGTERM, request_interruption)
    signal.signal(signal.SIGINT, request_interruption)

    def save():
        write_json(work / "build-result.json", report)

    def run(label, command, cwd, extra=None):
        remaining = phase_deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Stage budget expired before " + label)
        effective_timeout = min(args.command_timeout, remaining)
        log = logs / f"{len(results):02}-{label}.log"
        start = time.monotonic()
        item = {"name": label, "command": [str(x) for x in command], "cwd": str(cwd),
                "log": str(log.relative_to(work)), "exitCode": None,
                "buildId": report["buildId"], "timeoutSeconds": args.command_timeout,
                "effectiveTimeoutSeconds": effective_timeout,
                "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}
        results.append(item)
        save()
        with log.open("x") as output:
            output.write("$ " + " ".join(str(x) for x in command) + "\n")
            output.flush()
            interrupted = None
            try:
                execute_owned_process(command, cwd=cwd, env={**env, **(extra or {})}, output=output,
                                      timeout=effective_timeout, record=item, on_started=save)
            except Exception as exc:
                interrupted = exc
        item.update(seconds=round(time.monotonic() - start, 3), logSha256=sha256(log),
                    finishedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
        save()
        print(f"{label}: exit={item['exitCode']} ({item['seconds']}s), {log}", flush=True)
        if interrupted is not None:
            raise interrupted
        if item["exitCode"] != 0 or item.get("timedOut") or item.get("groupPresentAfterLeaderExit"):
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

    def observe_tooling():
        checked = {}
        sdk_tools = {"clang", "clang++", "wasm-ld", "wasm-opt", "wasm-emscripten-finalize", "wasm-metadce", "llvm-ar", "llvm-ranlib", "llvm-nm", "llvm-objcopy", "llvm-strip"}
        for name in ["emcc", *sorted(sdk_tools), "node", "python", "gcc", "make", "patch", "m4", "autoconf", "automake", "libtool", "pkg-config", "meson", "ninja"]:
            executable = (sdk / "upstream/bin" / name) if name in sdk_tools else (sys.executable if name == "python" else shutil.which(name, path=env["PATH"]))
            if executable is None or not Path(executable).is_file():
                raise ValueError(f"Missing build prerequisite: {name}")
            executable = Path(executable).resolve()
            checked[name] = {"path": str(executable), "sha256": sha256(executable)}
        identities = {"toolchainExecutables": checked, "externalBinaryToolIdentity": tree_identity(sdk / "upstream/bin")}
        if args.python_tools_dir:
            identities["pythonToolSourceIdentity"] = tree_identity(args.python_tools_dir.resolve())
        prefix = work / "python-bytecode"
        if prefix.exists() and any(prefix.rglob("*")):
            raise ValueError("Private Python cache prefix must stay empty; supplied bytecode is not accepted")
        return identities

    def observe_compiler_configuration():
        keys = ["EM_CONFIG", "LLVM_ROOT", "BINARYEN_ROOT", "NODE_JS", "CACHE", "PORTS", "COMPILER_WRAPPER", "LLVM_ADD_VERSION", "CLANG_ADD_VERSION"]
        command = [sys.executable, "-B", "-c", "import json; from tools import config; "
                   + "print(json.dumps({key:getattr(config,key) for key in " + repr(keys) + "},sort_keys=True))"]
        actual = json.loads(subprocess.check_output(command, cwd=private_em, env=env, text=True, timeout=20))
        expected = {"EM_CONFIG": env["EM_CONFIG"], "LLVM_ROOT": str(sdk / "upstream/bin"),
                    "BINARYEN_ROOT": str(sdk / "upstream"), "NODE_JS": [str(sdk / "node/16.20.0_64bit/bin/node")],
                    "CACHE": env["EM_CACHE"], "PORTS": str(work / "emscripten-cache/ports"),
                    "COMPILER_WRAPPER": None, "LLVM_ADD_VERSION": None, "CLANG_ADD_VERSION": None}
        if actual != expected:
            raise ValueError("Effective private compiler configuration differs from declared tools/cache")
        return {"command": command, "cwd": str(private_em), "effective": actual}

    def recheck_external_inputs():
        if observe_tooling() != initial_tooling:
            raise ValueError("External tool or Python package identities changed during this stage")
        if observe_compiler_configuration()["effective"] != compiler_configuration["effective"]:
            raise ValueError("Effective compiler configuration changed during this stage")
        invocation["externalToolIdentitiesUnchangedAtCompletion"] = True
        invocation["privatePythonCachePrefixEmptyAtCompletion"] = True

    try:
        if not continuing:
            report["compilerIsolation"] = prepare_private_compiler(
                work, sdk, RECIPE / "patches/emscripten-proxy-context-lifetime.patch")
            report["compilerCacheBasis"] = {"mode": "initially empty private cache; libc generated from private patched compiler source",
                                           "fileCount": 0, "treeSha256": tree_identity(work / "emscripten-cache")["treeSha256"]}
            save()
        else:
            isolation = report["compilerIsolation"]
            verify_tree(sdk / "upstream/emscripten", isolation["originalTree"], compiler_source=True)
            verify_tree(private_em, isolation["patchedTree"], compiler_source=True)
        initial_tooling = observe_tooling()
        for key, value in initial_tooling.items():
            if continuing and value != report.get(key):
                raise ValueError("External tool identities changed across clean build stages: " + key)
            report[key] = value
        invocation["toolchainExecutables"] = initial_tooling["toolchainExecutables"]
        invocation["externalInputTreeHashes"] = {k: v["treeSha256"] for k, v in initial_tooling.items() if k != "toolchainExecutables"}
        compiler_configuration = observe_compiler_configuration()
        if continuing and compiler_configuration["effective"] != report["effectiveCompilerConfiguration"]["effective"]:
            raise ValueError("Effective compiler configuration changed across clean build stages")
        report["effectiveCompilerConfiguration"] = compiler_configuration
        control_keys = ["PATH", "TMPDIR", "EM_CONFIG", "EM_CACHE", "EMSDK_PYTHON", "SOURCE_DATE_EPOCH", "TZ", "LC_ALL", "PYTHONHASHSEED", "PKG_CONFIG_PATH", "EM_PKG_CONFIG_PATH", "PYTHONPATH", "PYTHONDONTWRITEBYTECODE", "PYTHONNOUSERSITE", "PYTHONPYCACHEPREFIX", "EMCC_CORES", "BINARYEN_CORES", "CPATH", "CHOST"]
        controls = {k: env[k] for k in control_keys if k in env}
        if continuing and controls != report["compilerControlEnvironment"]:
            raise ValueError("Controlled environment changed across clean build stages")
        report["compilerControlEnvironment"] = controls
        invocation["effectiveCompilerConfiguration"] = compiler_configuration["effective"]
        report["nativeCompilerVersion"] = subprocess.check_output(["gcc", "--version"], env=env, text=True, timeout=20).splitlines()[0]
        version = subprocess.check_output([str(private_em / "emcc"), "--version"], env=env, text=True, timeout=20)
        if "3.1.50" not in version or LOCK["emscriptenRevision"] not in version:
            raise ValueError("Compiler version/revision does not match the input lock")
        report["compilerVersion"] = version.strip()
        # Fail before expensive dependency builds if QEMU cannot create its Python environment.
        python_check = subprocess.check_output([sys.executable, "-c",
            "import json,importlib.metadata as m; import distlib,venv,tomllib; "
            "print(json.dumps({n:m.version(n) for n in ['distlib','meson','ninja','packaging']}))"], env=env, text=True, timeout=20)
        python_versions = json.loads(python_check)
        expected_python = {"distlib": "0.3.9", "meson": "1.5.0", "ninja": "1.11.1.1", "packaging": "24.2"}
        if python_versions != expected_python:
            raise ValueError(f"Python build tools differ from pinned versions: {python_versions}")
        report["pythonPackages"] = python_versions
        for tool, expected in [("meson", "1.5.0"), ("ninja", "1.11.1")]:
            found = subprocess.check_output([tool, "--version"], env=env, text=True, timeout=20).strip()
            if not found.startswith(expected):
                raise ValueError(f"Expected {tool} {expected}, found {found}")
            report[tool + "Version"] = found
        flags = "-O2 -matomics -mbulk-memory -DNDEBUG -sWASM_BIGINT -DWASM_BIGINT -pthread -sMALLOC=emmalloc -sASYNCIFY=1"
        env.update(CFLAGS=flags, CXXFLAGS=flags, LDFLAGS=f"-L{target}/lib -O2")
        if not continuing:
            for name, archive in [("zlib", "zlib.tar.gz"), ("libffi", "libffi.tar.gz"),
                                  ("glib", "glib.tar.xz"), ("pixman", "pixman.tar.gz"),
                                  ("qemu", "qemu-wasm.tar.gz"), ("xterm-pty", "xterm-pty.tgz")]:
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
        if args.stage == "dependencies":
            recheck_external_inputs()
            isolation = report["compilerIsolation"]
            verify_tree(sdk / "upstream/emscripten", isolation["originalTree"], compiler_source=True)
            verify_tree(private_em, isolation["patchedTree"], compiler_source=True)
            report["status"] = "dependencies-complete"
            invocation.update(status="completed", finishedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
            save()
            shutil.copyfile(work / "build-result.json", work / "build-result.dependencies.json")
            boundary = stage_boundary(work, report["buildId"], "dependencies", configuration, recipe_identities)
            boundary["completedReportSha256"] = sha256(work / "build-result.json")
            write_json(work / "stage-boundary.json", boundary)
            print("QEMU_DEPENDENCIES_COMPLETE " + json.dumps({"buildId": report["buildId"], "boundarySha256": sha256(work / "stage-boundary.json")}))
            return
        if args.stage == "all":
            phase_deadline = time.monotonic() + args.stage_timeout
        env.update(CFLAGS=flags, CXXFLAGS=flags)
        qemu = source / "qemu"
        unpack("keycodemapdb.tar.gz", qemu / "subprojects/keycodemapdb")
        unpack("dtc.tar.gz", qemu / "subprojects/dtc")
        for name in ["berkeley-softfloat-3", "berkeley-testfloat-3"]:
            unpack(name + ".tar.gz", qemu / "subprojects" / name)
            shutil.copytree(qemu / "subprojects/packagefiles" / name, qemu / "subprojects" / name, dirs_exist_ok=True)
        obj = work / "qemu-build"
        obj.mkdir()
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
                              "--extra-ldflags=-sEXPORTED_RUNTIME_METHODS=getTempRet0,setTempRet0,addFunction,removeFunction,TTY,FS --emit-symbol-map -Wl,--trace-symbol=emscripten_proxy_sync_with_ctx -Wl,--trace-symbol=emscripten_proxy_finish"], obj)
        run("qemu-build", ["emmake", "make", f"-j{args.jobs}", "qemu-system-x86_64"], obj)
        output = work / "artifacts"
        output.mkdir()
        for source_name, output_name in [("qemu-system-x86_64", "out.js"), ("qemu-system-x86_64.wasm", "qemu-system-x86_64.wasm"),
                                         ("qemu-system-x86_64.worker.js", "qemu-system-x86_64.worker.js"),
                                         ("qemu-system-x86_64.symbols", "qemu-system-x86_64.symbols")]:
            destination = output / output_name
            shutil.copyfile(obj / source_name, destination)
            report["artifacts"].append({"file": output_name, "bytes": destination.stat().st_size, "sha256": sha256(destination)})
        build_log = (work / results[-1]["log"]).read_text(errors="replace")
        resolutions = {}
        for symbol in ["emscripten_proxy_sync_with_ctx", "emscripten_proxy_finish"]:
            lines = [line for line in build_log.splitlines() if "definition of " + symbol in line]
            if len(lines) != 1 or str(work / "emscripten-cache") not in lines[0] or "libc-mt.a(proxying.o)" not in lines[0]:
                raise ValueError("Corrected private libc symbol provider not proved: " + symbol + " " + repr(lines))
            resolutions[symbol] = lines[0]
        report["correctedSymbolProviders"] = resolutions
        isolation = report["compilerIsolation"]
        verify_tree(sdk / "upstream/emscripten", isolation["originalTree"], compiler_source=True)
        verify_tree(private_em, isolation["patchedTree"], compiler_source=True)
        report["compilerSourcesUnchangedDuringBuild"] = True
        recheck_external_inputs()
        report["generatedLibcArtifacts"] = [
            {"file": str(path.relative_to(work)), "bytes": path.stat().st_size, "sha256": sha256(path)}
            for path in sorted((work / "emscripten-cache").rglob("libc-mt*.a"))]
        if not report["generatedLibcArtifacts"]:
            raise ValueError("No generated private multithreaded libc recorded")
        report["symbolMapBinding"] = {"wasmSha256": sha256(output / "qemu-system-x86_64.wasm"),
                                      "symbolsSha256": sha256(output / "qemu-system-x86_64.symbols"),
                                      "producer": "Same completed final Emscripten link invocation; not a relink of other runtime bytes"}
        report["status"] = "built-unqualified"
        invocation.update(status="completed", finishedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
        save()
        print("QEMU_RUNTIME_BUILD_COMPLETE " + json.dumps({"buildId": report["buildId"], "status": report["status"],
                                                          "artifacts": report["artifacts"]}), flush=True)
        print(f"Built candidate artifacts: {output}. Application qualification remains required.")
    except Exception as exc:
        report.update(status="failed", error=str(exc))
        invocation.update(status="failed", error=str(exc), finishedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
        save()
        raise


if __name__ == "__main__":
    main()
