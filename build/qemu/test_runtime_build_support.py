"""Integrity fixtures for the clean runtime-build boundary, not guest tests."""
from pathlib import Path
import copy
import importlib.util
import json
import os
import py_compile
import signal
import shutil
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest import mock

from runtime_build_support import (CORRECTED_PROXY_SHA256, ORIGINAL_PROXY_SHA256,
    apply_proxy_backport, enable_child_subreaper, execute_owned_process, prepare_private_compiler, sha256, stage_boundary,
    sanitized_build_environment, terminate_process_group, tree_identity, verify_stage_boundary, write_json)

HERE = Path(__file__).resolve().parent
PATCH = HERE / "patches/emscripten-proxy-context-lifetime.patch"
ORIGINAL = HERE / "fixtures/emscripten-3.1.50-proxying.c"
TEMP_ROOT = HERE.parents[1] / ".cache/build-helper-tests"
COMPARISON_SPEC = importlib.util.spec_from_file_location("compare_builds", HERE / "compare-builds.py")
COMPARISON = importlib.util.module_from_spec(COMPARISON_SPEC)
COMPARISON_SPEC.loader.exec_module(COMPARISON)


class BuildSupportTests(unittest.TestCase):
    def setUp(self):
        TEMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=TEMP_ROOT)
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def compiler(self, path):
        source = path / "system/lib/pthread/proxying.c"
        source.parent.mkdir(parents=True)
        shutil.copyfile(ORIGINAL, source)
        return source

    def test_exact_patch_and_protected_original(self):
        original = self.compiler(self.root / "original")
        private = self.compiler(self.root / "private")
        result = apply_proxy_backport(self.root / "private", PATCH)
        self.assertEqual(result["exitCode"], 0)
        self.assertEqual(sha256(original), ORIGINAL_PROXY_SHA256)
        self.assertEqual(sha256(private), CORRECTED_PROXY_SHA256)

    def test_changed_or_prepatched_source_is_rejected(self):
        private = self.compiler(self.root / "private")
        private.write_bytes(private.read_bytes() + b"\n")
        before = private.read_bytes()
        with self.assertRaisesRegex(ValueError, "Unknown or already-patched"):
            apply_proxy_backport(self.root / "private", PATCH)
        self.assertEqual(private.read_bytes(), before)
        shutil.copyfile(ORIGINAL, private)
        apply_proxy_backport(self.root / "private", PATCH)
        with self.assertRaisesRegex(ValueError, "already-patched"):
            apply_proxy_backport(self.root / "private", PATCH)

    def test_changed_patch_is_rejected_before_source_mutation(self):
        private = self.compiler(self.root / "private")
        patch = self.root / "bad.patch"
        patch.write_bytes(PATCH.read_bytes() + b"\n")
        with self.assertRaisesRegex(ValueError, "patch identity mismatch"):
            apply_proxy_backport(self.root / "private", patch)
        self.assertEqual(sha256(private), ORIGINAL_PROXY_SHA256)

    def test_proxy_symlink_is_rejected(self):
        original = self.compiler(self.root / "original")
        private = self.root / "private/system/lib/pthread/proxying.c"
        private.parent.mkdir(parents=True)
        private.symlink_to(original)
        with self.assertRaisesRegex(ValueError, "ordinary file"):
            apply_proxy_backport(self.root / "private", PATCH)
        self.assertEqual(sha256(original), ORIGINAL_PROXY_SHA256)

    def test_private_source_copy_uses_empty_cache_and_independent_files(self):
        sdk = self.root / "sdk"
        original = self.compiler(sdk / "upstream/emscripten")
        cache = sdk / "upstream/emscripten/cache"
        cache.mkdir()
        (cache / "unpatched-libc.a").write_bytes(b"must not be copied")
        work = self.root / "build"
        work.mkdir()
        result = prepare_private_compiler(work, sdk, PATCH)
        self.assertEqual(list((work / "emscripten-cache").iterdir()), [])
        private = Path(result["privateSource"]) / "system/lib/pthread/proxying.c"
        self.assertNotEqual(private.stat().st_ino, original.stat().st_ino)
        self.assertEqual(sha256(original), ORIGINAL_PROXY_SHA256)
        self.assertEqual(sha256(private), CORRECTED_PROXY_SHA256)
        private.write_bytes(b"independent mutation")
        self.assertEqual(sha256(original), ORIGINAL_PROXY_SHA256)
        self.assertEqual((cache / "unpatched-libc.a").read_bytes(), b"must not be copied")

    def test_nonempty_private_compiler_or_cache_refused(self):
        sdk = self.root / "sdk"
        self.compiler(sdk / "upstream/emscripten")
        work = self.root / "build"
        (work / "emscripten-cache").mkdir(parents=True)
        sentinel = work / "emscripten-cache/sentinel"
        sentinel.write_bytes(b"preserve")
        with self.assertRaisesRegex(ValueError, "must start absent"):
            prepare_private_compiler(work, sdk, PATCH)
        self.assertEqual(sentinel.read_bytes(), b"preserve")

    def test_compiler_link_cannot_escape_private_tree(self):
        compiler = self.root / "compiler"
        self.compiler(compiler)
        outside = self.root / "outside"
        outside.write_text("not a compiler source member")
        (compiler / "outside-link").symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "escapes"):
            tree_identity(compiler, compiler_source=True)

    def boundary(self):
        (self.root / "object.o").write_bytes(b"compiled from this fresh build")
        configuration = {"jobs": 4, "runtimeCompatibility": "candidate-fixture"}
        recipes = {"recipe.py": "pinned-recipe", "patch": "pinned-patch"}
        boundary = stage_boundary(self.root, "unique-build", "dependencies", configuration, recipes)
        return boundary, configuration, recipes

    def test_unchanged_stage_boundary_passes(self):
        boundary, configuration, recipes = self.boundary()
        verify_stage_boundary(self.root, boundary, "unique-build", configuration, recipes)

    def test_changed_dependency_object_is_rejected(self):
        boundary, configuration, recipes = self.boundary()
        (self.root / "object.o").write_bytes(b"another build's object")
        with self.assertRaisesRegex(ValueError, "Build boundary changed"):
            verify_stage_boundary(self.root, boundary, "unique-build", configuration, recipes)

    def test_added_or_missing_dependency_path_is_rejected(self):
        boundary, configuration, recipes = self.boundary()
        added = self.root / "untracked.o"
        added.write_bytes(b"unexpected")
        with self.assertRaisesRegex(ValueError, "untracked.o"):
            verify_stage_boundary(self.root, boundary, "unique-build", configuration, recipes)
        added.unlink()
        (self.root / "object.o").unlink()
        with self.assertRaisesRegex(ValueError, "object.o"):
            verify_stage_boundary(self.root, boundary, "unique-build", configuration, recipes)

    def test_build_identity_recipe_and_configuration_are_bound(self):
        boundary, configuration, recipes = self.boundary()
        for build_id, config, recipe in [
            ("other-build", configuration, recipes),
            ("unique-build", {**configuration, "jobs": 8}, recipes),
            ("unique-build", configuration, {**recipes, "patch": "other-patch"}),
        ]:
            with self.subTest(build_id=build_id, config=config, recipe=recipe):
                with self.assertRaisesRegex(ValueError, "changed across stages"):
                    verify_stage_boundary(self.root, boundary, build_id, config, recipe)

    def test_incomplete_stage_cannot_continue(self):
        boundary, configuration, recipes = self.boundary()
        boundary["completedStage"] = "running"
        with self.assertRaisesRegex(ValueError, "Not a completed"):
            verify_stage_boundary(self.root, boundary, "unique-build", configuration, recipes)

    def comparison_build(self, path):
        return {"compilerIsolation": {"privateSource": path, "cacheInitialFileCount": 0,
                    "originalTree": {"treeSha256": "original-tree"},
                    "patchedTree": {"treeSha256": "corrected-tree"},
                    "patch": {"upstreamCommit": "commit", "patchSha256": "patch",
                              "inputSha256": "input", "outputSha256": "output"}},
                "compilerSourcesUnchangedDuringBuild": True,
                "toolchainExecutables": {"emcc": {"path": path + "/emcc", "sha256": "emcc-bytes"},
                                         "clang": {"path": "/immutable/clang", "sha256": "clang-bytes"}}}

    def test_independent_private_paths_compare_by_source_and_executable_identity(self):
        left = self.comparison_build("/build-a/compiler")
        right = self.comparison_build("/build-b/compiler")
        self.assertEqual(COMPARISON.toolchain_identity(left), COMPARISON.toolchain_identity(right))
        self.assertEqual(COMPARISON.compiler_source_identity(left), COMPARISON.compiler_source_identity(right))
        self.assertEqual(left["toolchainExecutables"]["emcc"]["path"], "/build-a/compiler/emcc")

    def test_changed_private_executable_cannot_compare_equal(self):
        left = self.comparison_build("/build-a/compiler")
        right = self.comparison_build("/build-b/compiler")
        right["toolchainExecutables"]["emcc"]["sha256"] = "changed"
        self.assertNotEqual(COMPARISON.toolchain_identity(left), COMPARISON.toolchain_identity(right))

    def test_changed_compiler_source_cannot_compare_equal(self):
        left = self.comparison_build("/build-a/compiler")
        right = self.comparison_build("/build-b/compiler")
        right["compilerIsolation"]["patchedTree"]["treeSha256"] = "changed"
        self.assertNotEqual(COMPARISON.compiler_source_identity(left), COMPARISON.compiler_source_identity(right))

    def test_only_declared_private_entry_point_is_normalized(self):
        build = self.comparison_build("/build-a/compiler")
        build["toolchainExecutables"]["emcc"]["path"] = "/unrelated/emcc"
        with self.assertRaisesRegex(ValueError, "not bound"):
            COMPARISON.toolchain_identity(build)

    def test_missing_cache_or_completion_proof_is_rejected(self):
        build = self.comparison_build("/build-a/compiler")
        for value in [False, True]:
            changed = copy.deepcopy(build)
            if value:
                changed["compilerIsolation"]["cacheInitialFileCount"] = 1
            else:
                changed["compilerSourcesUnchangedDuringBuild"] = False
            with self.assertRaisesRegex(ValueError, "empty cache or unchanged"):
                COMPARISON.compiler_source_identity(changed)

    def test_shared_tool_path_still_compares_exactly(self):
        left = self.comparison_build("/build-a/compiler")
        right = self.comparison_build("/build-b/compiler")
        right["toolchainExecutables"]["clang"]["path"] = "/different/clang"
        self.assertNotEqual(COMPARISON.toolchain_identity(left), COMPARISON.toolchain_identity(right))

    def test_cleanup_kills_remaining_worker_after_leader_exits_on_term(self):
        self.assertTrue(enable_child_subreaper()["enabled"])
        ready = self.root / "child-ready"
        script = ("import os,signal,time,sys\nfrom pathlib import Path\n"
                  "child=os.fork()\n"
                  "if child == 0:\n"
                  " signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
                  " Path(sys.argv[1]).write_text(str(os.getpid()))\n"
                  "while True: time.sleep(1)\n")
        proc = subprocess.Popen([sys.executable, "-c", script, str(ready)], start_new_session=True)
        try:
            deadline = time.monotonic() + 3
            while not ready.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(ready.is_file(), "owned worker failed to become ready")
            result = terminate_process_group(proc, grace_seconds=0.15, kill_seconds=1)
            self.assertTrue(result["completed"], result)
            self.assertTrue(result["groupPresentAfterTerm"], result)
            self.assertEqual([s["signal"] for s in result["signals"]], ["SIGTERM", "SIGKILL"])
            self.assertFalse(result["groupPresentAfterCleanup"])
            self.assertTrue(result["reapedAdoptedChildren"], result)
        finally:
            terminate_process_group(proc, grace_seconds=0.1, kill_seconds=1)

    def test_exited_group_is_complete_without_spurious_signal(self):
        proc = subprocess.Popen([sys.executable, "-c", "pass"], start_new_session=True)
        proc.wait(timeout=3)
        result = terminate_process_group(proc, grace_seconds=0.01, kill_seconds=0.01)
        self.assertTrue(result["completed"])
        self.assertEqual(result["signals"], [])

    def test_signal_lookup_race_is_recorded_as_exit(self):
        proc = SimpleNamespace(pid=999999, poll=lambda: 0)
        with mock.patch("runtime_build_support.process_group_exists", side_effect=[True, False, False]), mock.patch(
                "runtime_build_support.os.killpg", side_effect=ProcessLookupError):
            result = terminate_process_group(proc, grace_seconds=0.01, kill_seconds=0.01)
        self.assertTrue(result["completed"])
        self.assertEqual(result["signals"][0]["result"], "group-exited-before-signal")

    def test_ambient_compiler_and_interpreter_controls_are_removed(self):
        injected = {key: "must-not-run-or-be-recorded" for key in [
            "EM_LLVM_ROOT", "EM_BINARYEN_ROOT", "EM_NODE_JS", "EM_COMPILER_WRAPPER", "EM_PORTS",
            "EM_CACHE", "EM_CONFIG", "EM_LLVM_ADD_VERSION", "EM_CLANG_ADD_VERSION", "EMCC_CFLAGS",
            "EMCC_SKIP_SANITY_CHECK", "EMMAKEN_COMPILER", "EMSDK_PYTHON", "CC", "CXX", "AR", "LD",
            "CFLAGS", "CPPFLAGS", "LDFLAGS", "PKG_CONFIG_LIBDIR", "MAKEFLAGS", "BASH_ENV",
            "PYTHONPATH", "PYTHONPYCACHEPREFIX", "PYTHONHOME", "LD_PRELOAD"]}
        actual, removed = sanitized_build_environment({**injected, "HOME": "/preserved-home", "PATH": "/host-bin"})
        self.assertEqual(actual, {"HOME": "/preserved-home", "PATH": "/host-bin"})
        self.assertEqual(removed, sorted(injected))

    def test_private_pycache_prefix_ignores_valid_poisoned_external_bytecode(self):
        module = self.root / "cache_policy_fixture.py"
        module.write_text("VALUE='source'\n")
        meta = module.stat()
        module.write_text("VALUE='poison'\n")
        os.utime(module, ns=(meta.st_atime_ns, meta.st_mtime_ns))
        py_compile.compile(str(module), doraise=True)
        module.write_text("VALUE='source'\n")
        os.utime(module, ns=(meta.st_atime_ns, meta.st_mtime_ns))
        command = [sys.executable, "-c", "import cache_policy_fixture as m; print(m.VALUE)"]
        env, _ = sanitized_build_environment(os.environ)
        env.update(PYTHONDONTWRITEBYTECODE="1", PYTHONNOUSERSITE="1")
        control = subprocess.check_output(command, cwd=self.root, env=env, text=True, timeout=3).strip()
        self.assertEqual(control, "poison", "control must prove that -B/no-write alone consumes the poisoned cache")
        prefix = self.root / "fresh-python-cache"
        self.assertFalse(prefix.exists())
        env["PYTHONPYCACHEPREFIX"] = str(prefix)
        protected = subprocess.check_output(command, cwd=self.root, env=env, text=True, timeout=3).strip()
        self.assertEqual(protected, "source")
        self.assertFalse(prefix.exists(), "no-write policy must leave private bytecode prefix absent")

    def environment_build(self, path):
        build = self.comparison_build(path + "/compiler/emscripten")
        roles = {"EM_CONFIG": "compiler/emscripten.config.py", "EM_CACHE": "emscripten-cache",
                 "TMPDIR": "tmp", "PYTHONPYCACHEPREFIX": "python-bytecode", "CPATH": "target/include",
                 "PKG_CONFIG_PATH": "target/lib/pkgconfig", "EM_PKG_CONFIG_PATH": "target/lib/pkgconfig"}
        build["compilerControlEnvironment"] = {key: path + "/" + role for key, role in roles.items()}
        build["compilerControlEnvironment"].update(PATH=path + "/compiler/emscripten:/shared/tools", EMSDK_PYTHON="/shared/python")
        build["effectiveCompilerConfiguration"] = {"effective": {"EM_CONFIG": path + "/compiler/emscripten.config.py",
            "CACHE": path + "/emscripten-cache", "PORTS": path + "/emscripten-cache/ports", "LLVM_ROOT": "/shared/llvm", "COMPILER_WRAPPER": None}}
        return build

    def test_compiler_environment_only_normalizes_verified_build_roles(self):
        left, right = self.environment_build("/build-a"), self.environment_build("/build-b")
        self.assertEqual(COMPARISON.compiler_environment_identity(left), COMPARISON.compiler_environment_identity(right))
        right["effectiveCompilerConfiguration"]["effective"]["LLVM_ROOT"] = "/alternate/llvm"
        self.assertNotEqual(COMPARISON.compiler_environment_identity(left), COMPARISON.compiler_environment_identity(right))
        right["compilerControlEnvironment"]["EM_CACHE"] = "/other-build/cache"
        with self.assertRaisesRegex(ValueError, "Unbound"):
            COMPARISON.compiler_environment_identity(right)

    def test_interruption_during_post_launch_reporting_cleans_owned_group_and_records_repeated_signal(self):
        enable_child_subreaper()
        ready = self.root / "reporting-interruption-ready"
        script = ("import os,signal,time,sys\nfrom pathlib import Path\n"
                  "def terminate(sig,frame):\n"
                  " signal.signal(signal.SIGTERM,signal.SIG_IGN)\n"
                  " os.kill(os.getppid(),signal.SIGTERM)\n"
                  "signal.signal(signal.SIGTERM,terminate)\n"
                  "Path(sys.argv[1]).write_text(str(os.getpid()))\n"
                  "while True: time.sleep(1)\n")
        record = {}
        previous = signal.getsignal(signal.SIGTERM)

        def interrupted(_signal, _frame):
            raise InterruptedError("fixture interruption during post-launch reporting")

        def report_started():
            deadline = time.monotonic() + 3
            while not ready.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(ready.is_file())
            with mock.patch("runtime_build_support.os.fsync", side_effect=lambda _fd: os.kill(os.getpid(), signal.SIGTERM)):
                write_json(self.root / "interrupted-report.json", record)

        signal.signal(signal.SIGTERM, interrupted)
        try:
            with (self.root / "interruption.log").open("w") as output:
                with self.assertRaisesRegex(InterruptedError, "post-launch reporting"):
                    execute_owned_process([sys.executable, "-c", script, str(ready)], cwd=self.root,
                        env=os.environ.copy(), output=output, timeout=8, record=record, on_started=report_started)
            self.assertTrue(record["cleanup"]["completed"], record)
            self.assertFalse(record["cleanup"]["groupPresentAfterCleanup"])
            self.assertEqual(record["signalsDuringCleanup"], ["SIGTERM"])
            self.assertEqual(record["exitCode"], -signal.SIGKILL)
            self.assertFalse((self.root / "interrupted-report.json.writing").exists())
            write_json(self.root / "interrupted-report.json", record)
            self.assertTrue(json.loads((self.root / "interrupted-report.json").read_text())["cleanup"]["completed"])
        finally:
            signal.signal(signal.SIGTERM, previous)

    def test_launch_signal_is_deferred_until_actual_child_handle_is_owned(self):
        enable_child_subreaper()
        native_popen = subprocess.Popen
        record = {}
        previous = signal.getsignal(signal.SIGTERM)

        def interrupted(_signal, _frame):
            raise InterruptedError("signal escaped launch ownership")

        def interrupt_before_return(*args, **kwargs):
            child = native_popen(*args, **kwargs)
            os.kill(os.getpid(), signal.SIGTERM)
            return child

        signal.signal(signal.SIGTERM, interrupted)
        try:
            with (self.root / "launch-interruption.log").open("w") as output, mock.patch(
                    "runtime_build_support.subprocess.Popen", side_effect=interrupt_before_return):
                with self.assertRaisesRegex(InterruptedError, "during process launch"):
                    execute_owned_process([sys.executable, "-c", "import time; time.sleep(20)"],
                        cwd=self.root, env=os.environ.copy(), output=output, timeout=5,
                        record=record, on_started=lambda: self.fail("reporting must not run after a pending launch interruption"))
            self.assertEqual(record["signalsDuringLaunch"], ["SIGTERM"])
            self.assertTrue(record["cleanup"]["completed"], record)
            self.assertFalse(record["cleanup"]["groupPresentAfterCleanup"])
        finally:
            signal.signal(signal.SIGTERM, previous)


if __name__ == "__main__":
    unittest.main(verbosity=2)
