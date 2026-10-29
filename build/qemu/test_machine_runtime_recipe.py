import importlib.util
import ast
import json
from pathlib import Path
import tempfile
import unittest

MODULE_PATH = Path(__file__).with_name("build-machine-runtime.py")
spec = importlib.util.spec_from_file_location("machine_runtime_recipe", MODULE_PATH)
recipe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recipe)
V2_MODULE_PATH = Path(__file__).with_name("build-machine-runtime-v2.py")
v2_spec = importlib.util.spec_from_file_location("machine_runtime_recipe_v2", V2_MODULE_PATH)
recipe_v2 = importlib.util.module_from_spec(v2_spec)
v2_spec.loader.exec_module(recipe_v2)

V3_MODULE_PATH = Path(__file__).with_name("build-machine-runtime-v3.py")
v3_spec = importlib.util.spec_from_file_location("machine_runtime_recipe_v3", V3_MODULE_PATH)
recipe_v3 = importlib.util.module_from_spec(v3_spec)
v3_spec.loader.exec_module(recipe_v3)


class MachineRuntimeRecipeTests(unittest.TestCase):
    def test_derivation_is_exact_repeatable_and_preserves_original_recipe(self):
        original = {name: (recipe.RECIPE / name).read_bytes() for name in recipe.FILES}
        with tempfile.TemporaryDirectory() as temporary:
            first, second = Path(temporary) / "first", Path(temporary) / "second"
            a, b = recipe.derive_recipe(recipe.RECIPE, first), recipe.derive_recipe(recipe.RECIPE, second)
            self.assertEqual(a, b)
            self.assertEqual(a, recipe.derive_recipe(recipe.RECIPE, first))
            self.assertIn(b"-sTOTAL_MEMORY=3584MB", (first / "build-runtime.py").read_bytes())
            lock = json.loads((first / "inputs.lock.json").read_text())
            self.assertEqual(lock["candidateRuntimeCompatibility"], recipe.SERVER_RUNTIME)
            self.assertEqual(lock["machineBuildProfile"]["guestMemoryMiB"], 2048)
            (first / "build-runtime.py").write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "Existing derived recipe changed"):
                recipe.derive_recipe(recipe.RECIPE, first)
        self.assertEqual(original, {name: (recipe.RECIPE / name).read_bytes() for name in recipe.FILES})

    def test_unexpected_existing_file_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "recipe"
            recipe.derive_recipe(recipe.RECIPE, target)
            (target / "user-work").write_text("preserve")
            with self.assertRaisesRegex(ValueError, "unexpected files"):
                recipe.derive_recipe(recipe.RECIPE, target)
            self.assertEqual((target / "user-work").read_text(), "preserve")

    def test_v2_binds_every_source_patch_without_changing_s1_or_v1_recipe(self):
        original = {name: (recipe_v2.RECIPE / name).read_bytes() for name in recipe_v2.FILES}
        original_v1 = MODULE_PATH.read_bytes()
        with tempfile.TemporaryDirectory() as temporary:
            first, second = Path(temporary) / "first", Path(temporary) / "second"
            a = recipe_v2.derive_recipe(recipe_v2.RECIPE, first)
            self.assertEqual(a, recipe_v2.derive_recipe(recipe_v2.RECIPE, second))
            self.assertEqual(a, recipe_v2.derive_recipe(recipe_v2.RECIPE, first))
            generated = (first / "build-runtime.py").read_text()
            ast.parse(generated)
            ast.parse((first / "runtime_build_support.py").read_text())
            self.assertIn('"--fuzz=0"', generated)
            self.assertIn('report["qemuSourceCorrections"]', generated)
            self.assertIn('correction["unchangedAtCompletion"] = True', generated)
            lock = json.loads((first / "inputs.lock.json").read_text())
            self.assertEqual(lock["candidateRuntimeCompatibility"], recipe_v2.SERVER_RUNTIME)
            self.assertEqual(lock["machineBuildProfile"]["memoryLayout"], "split-2x1024m-ram-blocks-v1")
            self.assertEqual(lock["qemuSourceCorrections"], recipe_v2.CORRECTIONS)
            corrected = [item["file"] for correction in lock["qemuSourceCorrections"] for item in correction["files"]]
            self.assertEqual(corrected, ["tcg/wasm32.c", "hw/core/machine.c", "util/mmap-alloc.c"])
            (first / "patches/qemu-wasm32-segmented-ram.patch").write_text("changed")
            with self.assertRaisesRegex(ValueError, "Existing derived recipe changed"):
                recipe_v2.derive_recipe(recipe_v2.RECIPE, first)
        self.assertEqual(original, {name: (recipe_v2.RECIPE / name).read_bytes() for name in recipe_v2.FILES})
        self.assertEqual(original_v1, MODULE_PATH.read_bytes())

    def test_v3_libffi_correction_is_bound_before_dependency_compilation(self):
        original = {name: (recipe_v3.RECIPE / name).read_bytes() for name in recipe_v3.FILES}
        original_v2 = V2_MODULE_PATH.read_bytes()
        with tempfile.TemporaryDirectory() as temporary:
            first, second = Path(temporary) / "first", Path(temporary) / "second"
            a = recipe_v3.derive_recipe(recipe_v3.RECIPE, first)
            self.assertEqual(a, recipe_v3.derive_recipe(recipe_v3.RECIPE, second))
            self.assertEqual(a, recipe_v3.derive_recipe(recipe_v3.RECIPE, first))
            generated = (first / "build-runtime.py").read_text()
            ast.parse(generated)
            ast.parse((first / "runtime_build_support.py").read_text())
            lock = json.loads((first / "inputs.lock.json").read_text())
            self.assertEqual(lock["candidateRuntimeCompatibility"], recipe_v3.SERVER_RUNTIME)
            self.assertEqual(lock["qemuSourceCorrections"], recipe_v3.CORRECTIONS)
            self.assertEqual(lock["libffiSourceCorrection"], recipe_v3.LIBFFI_CORRECTION)
            steps = ['run(correction["patch"].removesuffix(".patch")', 'run("ffi-autoreconf"',
                     'run("ffi-install"', 'observed["unchangedAfterDependencies"] = True',
                     'if args.stage == "dependencies":',
                     'report["libffiSourceCorrection"]["unchangedAtCompletion"] = True']
            positions = [generated.index(step) for step in steps]
            self.assertEqual(positions, sorted(positions))
            self.assertIn('observed.get("unchangedAfterDependencies") is not True', generated)
            (first / "patches/libffi-wasm32-unsigned-addresses.patch").write_text("changed")
            with self.assertRaisesRegex(ValueError, "Existing derived recipe changed"):
                recipe_v3.derive_recipe(recipe_v3.RECIPE, first)
        self.assertEqual(original, {name: (recipe_v3.RECIPE / name).read_bytes() for name in recipe_v3.FILES})
        self.assertEqual(original_v2, V2_MODULE_PATH.read_bytes())

    def test_v3_rejects_changed_source_patch_before_creating_recipe(self):
        import shutil
        with tempfile.TemporaryDirectory() as temporary:
            source, target = Path(temporary) / "input", Path(temporary) / "output"
            for name in recipe_v3.FILES:
                destination = source / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(recipe_v3.RECIPE / name, destination)
            (source / "patches/libffi-wasm32-unsigned-addresses.patch").write_text("changed")
            with self.assertRaisesRegex(ValueError, "reviewed source patch changed"):
                recipe_v3.derive_recipe(source, target)
            self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
