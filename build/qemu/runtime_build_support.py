"""Fail-closed compiler isolation and clean-build stage boundaries."""
from __future__ import annotations

import ctypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import time

RUNTIME_COMPATIBILITY = "qemu@8.2.0-terrarium-0ef7b4e-s1-candidate-v3"
UPSTREAM_COMMIT = "f3fef05bf5d63df33ed21eb067b86d827c546bfa"
PATCH_SHA256 = "b7e288932df00f55d71e0c49871cc9ee650fc6501c0e15de9926ebe808cf97a8"
ORIGINAL_PROXY_SHA256 = "a772941ebd474044ba1eeb3172c9e4e0135c8d407e4a5ce7a77561780c7e44c3"
CORRECTED_PROXY_SHA256 = "f358743d94ce4ac58577399b23d2497dd2dcb4de7c494fb28d4dbff74e0439d5"
STAGE_EXCLUSIONS = frozenset({"build-result.json", "stage-boundary.json"})
COMPILER_CONTROL_NAMES = frozenset({
    "LLVM", "BINARYEN", "NODE", "CC", "CXX", "CPP", "LD", "AR", "AS", "NM", "RANLIB",
    "OBJCOPY", "STRIP", "READELF", "CROSS_COMPILE", "HOST_CC", "HOST_CXX", "CC_FOR_BUILD",
    "CXX_FOR_BUILD", "LD_FOR_BUILD", "CFLAGS", "CXXFLAGS", "CPPFLAGS", "LDFLAGS", "ASFLAGS",
    "ARFLAGS", "LIBS", "PKG_CONFIG", "PKG_CONFIG_PATH", "PKG_CONFIG_LIBDIR", "PKG_CONFIG_SYSROOT_DIR",
    "CPATH", "C_INCLUDE_PATH", "CPLUS_INCLUDE_PATH", "LIBRARY_PATH", "LD_LIBRARY_PATH", "LD_PRELOAD",
    "MAKEFLAGS", "MFLAGS", "GNUMAKEFLAGS", "CONFIG_SITE", "CONFIG_SHELL", "BASH_ENV", "ENV",
})
COMPILER_CONTROL_PREFIXES = ("EM_", "EMCC_", "EMMAKEN_", "EMSDK_", "LLVM_", "CLANG_", "BINARYEN_", "PYTHON")


def sanitized_build_environment(inherited: dict) -> tuple[dict, list[str]]:
    """Remove ambient compiler/interpreter overrides; never report their values."""
    removed = sorted(name for name in inherited if name in COMPILER_CONTROL_NAMES or name.startswith(COMPILER_CONTROL_PREFIXES))
    return {name: value for name, value in inherited.items() if name not in removed}, removed


def sha256(path: Path) -> str:
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path: Path, value) -> None:
    path = Path(path)
    temporary = path.with_name(path.name + ".writing")
    created = False
    try:
        with temporary.open("x") as output:
            created = True
            output.write(json.dumps(value, indent=2) + "\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    except BaseException:
        if created:
            temporary.unlink(missing_ok=True)
        raise


def enable_child_subreaper() -> dict:
    """Adopt/reap abandoned owned workers on the supported Linux build host."""
    library = ctypes.CDLL(None, use_errno=True)
    prior = ctypes.c_int()
    if library.prctl(37, ctypes.byref(prior), 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "Cannot inspect child-subreaper setting")
    if library.prctl(36, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "Cannot enable child subreaper")
    checked = ctypes.c_int()
    if library.prctl(37, ctypes.byref(checked), 0, 0, 0) != 0 or checked.value != 1:
        raise RuntimeError("Child subreaper was not enabled")
    return {"enabled": True, "previousValue": prior.value, "method": "Linux PR_SET_CHILD_SUBREAPER"}


def process_group_exists(pgid: int) -> bool:
    """Probe only the child's known owned process group; /proc is not required."""
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False


def terminate_process_group(proc: subprocess.Popen, *, grace_seconds=5, kill_seconds=5) -> dict:
    """Bounded termination and adopted-child reaping for the owned new session.

    Call enable_child_subreaper before creating the process. The leader is
    reaped through Popen before waitpid is allowed to reap adopted workers.
    A leader exit alone is never treated as proof that its group is empty.
    """
    pgid = proc.pid
    result = {"processGroup": pgid, "initialGroupPresent": process_group_exists(pgid),
              "signals": [], "reapedAdoptedChildren": []}

    def send(sig):
        record = {"signal": sig.name}
        try:
            os.killpg(pgid, sig)
            record["result"] = "sent-to-owned-group"
        except ProcessLookupError:
            record["result"] = "group-exited-before-signal"
        result["signals"].append(record)

    def settle(seconds):
        deadline = time.monotonic() + seconds
        while True:
            if proc.poll() is not None:
                while True:
                    try:
                        pid, status = os.waitpid(-pgid, os.WNOHANG)
                    except ChildProcessError:
                        break
                    if not pid:
                        break
                    result["reapedAdoptedChildren"].append({"pid": pid, "waitStatus": status})
            present = process_group_exists(pgid)
            if not present or time.monotonic() >= deadline:
                return present
            time.sleep(min(0.05, max(0, deadline - time.monotonic())))

    if result["initialGroupPresent"]:
        send(signal.SIGTERM)
    after_term = settle(grace_seconds)
    result["groupPresentAfterTerm"] = after_term
    if after_term:
        send(signal.SIGKILL)
    result["groupPresentAfterCleanup"] = settle(kill_seconds)
    result["leaderExitCode"] = proc.poll()
    result["completed"] = not result["groupPresentAfterCleanup"] and result["leaderExitCode"] is not None
    return result


def execute_owned_process(command, *, cwd, env, output, timeout, record, on_started) -> None:
    """Own launch, reporting, waiting and cleanup as one exception-safe lifetime."""
    proc = None

    def cleanup():
        prior = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}

        def during_cleanup(signum, _frame):
            record.setdefault("signalsDuringCleanup", []).append(signal.Signals(signum).name)

        for sig in prior:
            signal.signal(sig, during_cleanup)
        try:
            record["cleanup"] = terminate_process_group(proc)
        finally:
            for sig, handler in prior.items():
                signal.signal(sig, handler)

    try:
        launch_handlers = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
        pending_signals = []

        def during_launch(signum, _frame):
            pending_signals.append(signal.Signals(signum).name)

        try:
            for sig in launch_handlers:
                signal.signal(sig, during_launch)
            proc = subprocess.Popen(command, cwd=cwd, env=env, stdout=output,
                                    stderr=subprocess.STDOUT, start_new_session=True)
            record["pid"] = proc.pid
            record["processGroup"] = os.getpgid(proc.pid)
        finally:
            for sig, handler in launch_handlers.items():
                signal.signal(sig, handler)
        if pending_signals:
            record["signalsDuringLaunch"] = pending_signals
            raise InterruptedError("Build interrupted during process launch: " + ", ".join(pending_signals))
        on_started()
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            record["timedOut"] = True
            cleanup()
        else:
            if process_group_exists(proc.pid):
                record["groupPresentAfterLeaderExit"] = True
                cleanup()
    except Exception as exc:
        record["interrupted"] = str(exc)
        if proc is not None and not record.get("cleanup", {}).get("completed"):
            cleanup()
        raise
    finally:
        if proc is not None:
            record["exitCode"] = proc.poll()


def tree_identity(root: Path, *, exclusions=(), compiler_source=False) -> dict:
    """Hash bytes/modes/link targets; never traverse directory symlinks."""
    root = Path(root).resolve()
    records = []
    for directory, dirs, files in os.walk(root, followlinks=False):
        base = Path(directory)
        dirs[:] = sorted(d for d in dirs if d != "__pycache__" and not (
            compiler_source and base == root and d == "cache"))
        # A directory symlink is a record, not a traversed source tree.
        names = list(files) + [d for d in dirs if (base / d).is_symlink()]
        dirs[:] = [d for d in dirs if not (base / d).is_symlink()]
        for name in sorted(names):
            path = base / name
            relative = path.relative_to(root).as_posix()
            if relative in exclusions or name.endswith((".pyc", ".pyo")):
                continue
            meta = path.lstat()
            record = {"path": relative, "mode": stat.S_IMODE(meta.st_mode)}
            if stat.S_ISLNK(meta.st_mode):
                target = path.resolve()
                if compiler_source and not target.is_relative_to(root):
                    raise ValueError(f"Compiler source link escapes its tree: {path}")
                record.update(kind="symlink", target=os.readlink(path))
                if target.is_file():
                    record["targetSha256"] = sha256(target)
            elif stat.S_ISREG(meta.st_mode):
                record.update(kind="file", bytes=meta.st_size, sha256=sha256(path))
            else:
                raise ValueError(f"Unsupported build-tree entry: {path}")
            records.append(record)
    records.sort(key=lambda r: r["path"])
    encoded = json.dumps(records, sort_keys=True, separators=(",", ":")).encode()
    return {"files": records, "fileCount": len(records), "treeSha256": hashlib.sha256(encoded).hexdigest()}


def verify_tree(root: Path, expected: dict, **options) -> dict:
    actual = tree_identity(root, **options)
    if actual != expected:
        old = {r["path"]: r for r in expected["files"]}
        new = {r["path"]: r for r in actual["files"]}
        changed = sorted(k for k in old.keys() | new.keys() if old.get(k) != new.get(k))
        raise ValueError("Build boundary changed: " + ", ".join(changed[:20]))
    return actual


def apply_proxy_backport(compiler_source: Path, patch: Path, patch_executable="patch") -> dict:
    """Patch only a caller-owned private compiler copy, with exact input/output pins."""
    compiler_source = Path(compiler_source).resolve()
    path = compiler_source / "system/lib/pthread/proxying.c"
    if path.is_symlink() or not path.is_file():
        raise ValueError("The private proxying.c must be an ordinary file")
    if sha256(patch) != PATCH_SHA256:
        raise ValueError("Proxy-context backport patch identity mismatch")
    if sha256(path) != ORIGINAL_PROXY_SHA256:
        raise ValueError("Unknown or already-patched proxying.c; refusing patch")
    command = [str(patch_executable), "--batch", "--forward", "--fuzz=0", "--no-backup-if-mismatch", "-p1", "-i", str(Path(patch).resolve())]
    result = subprocess.run(command, cwd=compiler_source, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
    if result.returncode != 0 or sha256(path) != CORRECTED_PROXY_SHA256:
        raise RuntimeError("Private proxy-context patch did not produce its exact declared output: " + result.stderr.decode(errors="replace"))
    return {"upstreamCommit": UPSTREAM_COMMIT, "patchSha256": PATCH_SHA256,
            "inputSha256": ORIGINAL_PROXY_SHA256, "outputSha256": CORRECTED_PROXY_SHA256,
            "command": command, "cwd": str(compiler_source), "exitCode": result.returncode,
            "stdout": result.stdout.decode(errors="replace"), "stderr": result.stderr.decode(errors="replace")}


def prepare_private_compiler(work: Path, sdk: Path, patch: Path, patch_executable="patch") -> dict:
    work, sdk = Path(work).resolve(), Path(sdk).resolve()
    original = sdk / "upstream/emscripten"
    destination = work / "compiler/emscripten"
    cache = work / "emscripten-cache"
    if destination.exists() or cache.exists():
        raise ValueError("Private compiler and cache must start absent")
    original_identity = tree_identity(original, compiler_source=True)
    destination.parent.mkdir()
    shutil.copytree(original, destination, symlinks=True,
                    ignore=lambda directory, names: [n for n in names if n == "__pycache__" or n.endswith((".pyc", ".pyo")) or (Path(directory) == original and n == "cache")])
    verify_tree(destination, original_identity, compiler_source=True)
    correction = apply_proxy_backport(destination, patch, patch_executable)
    corrected_identity = tree_identity(destination, compiler_source=True)
    cache.mkdir()
    config = work / "compiler/emscripten.config.py"
    node = sdk / "node/16.20.0_64bit/bin/node"
    config.write_text(
        "# Private compiler source and cache; immutable supplied executable tools.\n"
        + "NODE_JS = " + repr(str(node)) + "\n"
        + "LLVM_ROOT = " + repr(str(sdk / "upstream/bin")) + "\n"
        + "BINARYEN_ROOT = " + repr(str(sdk / "upstream")) + "\n"
        + "EMSCRIPTEN_ROOT = " + repr(str(destination)) + "\n"
        + "CACHE = " + repr(str(cache)) + "\n"
        + "COMPILER_ENGINE = NODE_JS\nJS_ENGINES = [NODE_JS]\n")
    verify_tree(original, original_identity, compiler_source=True)
    return {"mode": "private patched compiler source with initially empty private cache",
            "originalSource": str(original), "privateSource": str(destination),
            "originalTree": original_identity, "patchedTree": corrected_identity,
            "config": str(config), "configSha256": sha256(config), "cache": str(cache),
            "cacheInitialFileCount": 0, "patch": correction,
            "sharedExecutableTools": {"node": str(node), "llvm": str(sdk / "upstream/bin"), "binaryen": str(sdk / "upstream")}}


def stage_boundary(work: Path, build_id: str, stage: str, configuration: dict, recipe_identities: dict) -> dict:
    return {"schema": "terrarium.clean-runtime-stage-boundary/v1", "buildId": build_id,
            "completedStage": stage, "configuration": configuration,
            "recipeIdentities": recipe_identities,
            "tree": tree_identity(work, exclusions=STAGE_EXCLUSIONS)}


def verify_stage_boundary(work: Path, boundary: dict, build_id: str, configuration: dict, recipe_identities: dict) -> None:
    if boundary.get("schema") != "terrarium.clean-runtime-stage-boundary/v1" or boundary.get("completedStage") != "dependencies":
        raise ValueError("Not a completed dependency-stage boundary")
    if boundary.get("buildId") != build_id or boundary.get("configuration") != configuration or boundary.get("recipeIdentities") != recipe_identities:
        raise ValueError("Build ID, recipe, patch, tool selection or configuration changed across stages")
    verify_tree(work, boundary["tree"], exclusions=STAGE_EXCLUSIONS)
