# SPDX-License-Identifier: Apache-2.0
"""Regression checks for shipped recipe identity, source closure and delivery binding."""
import io
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest

import source_archive as source


class SourceClosureTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='source-closure-')
        self.root = Path(self.temporary.name) / 'kit'
        for name in source.payload_paths(source.ROOT) + [source.INVENTORY, source.DELIVERY]:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source.ROOT / name, target)

    def tearDown(self):
        self.temporary.cleanup()

    def test_all_shipped_variants_and_original_inputs_close(self):
        result = source.check(self.root)
        self.assertEqual(len(result['sourceInputs']), 39)
        self.assertEqual(result, source.expected_inventory(self.root))

    def test_missing_referenced_helper_config_patch_and_historical_recipe_fail(self):
        for name in ['build/qemu/runtime_build_support.py', 'build/qemu/guest_modules.py',
                     'build/qemu/mke2fs.conf',
                     'build/qemu/distribution/aports/aports-v3.21.4.tar.gz/main/alpine-baselayout/alpine-baselayout.post-upgrade', 'build/qemu/patches/libffi-wasm32-unsigned-addresses.patch',
                     'build/qemu/reconstruction/owned-s1-candidate-v2/build-runtime.py']:
            with self.subTest(name=name):
                path = self.root / name
                content = path.read_bytes()
                path.unlink()
                with self.assertRaises((ValueError, FileNotFoundError)):
                    source.check(self.root)
                path.write_bytes(content)

    def test_newest_recipe_cannot_replace_historical_v2(self):
        historical = self.root / 'build/qemu/reconstruction/owned-s1-candidate-v2/build-runtime.py'
        historical.write_bytes((self.root / 'build/qemu/build-runtime.py').read_bytes())
        with self.assertRaisesRegex(ValueError, 'Historical recipe identity'):
            source.check(self.root)

    def test_input_repin_and_supplemental_omission_fail(self):
        path = self.root / source.CLOSURE
        original = json.loads(path.read_text())
        changed = json.loads(path.read_text())
        changed['sourceInputs'][0]['sha256'] = '0' * 64
        path.write_bytes(source.encoded(changed))
        with self.assertRaisesRegex(ValueError, 'Original source pin changed'):
            source.check(self.root)
        original['sourceInputs'] = [i for i in original['sourceInputs'] if i['file'] != 'services-6.4']
        path.write_bytes(source.encoded(original))
        with self.assertRaisesRegex(ValueError, '39 unique'):
            source.check(self.root)

    def test_delivery_inventory_binding_cannot_go_stale(self):
        path = self.root / source.DELIVERY
        data = json.loads(path.read_text())
        data['inventory']['sha256'] = '0' * 64
        path.write_bytes(source.encoded(data))
        with self.assertRaisesRegex(ValueError, 'Source identity mismatch'):
            source.check(self.root)

    def archive(self, entries):
        path = Path(self.temporary.name) / 'fixture.tar.gz'
        with tarfile.open(path, 'w:gz') as archive:
            for name, data, kind in entries:
                member = tarfile.TarInfo(name)
                member.type = kind
                if kind == tarfile.REGTYPE:
                    member.size = len(data)
                    archive.addfile(member, io.BytesIO(data))
                else:
                    member.linkname = '../../outside'
                    archive.addfile(member)
        manifest_path = self.root / source.DELIVERY
        manifest = json.loads(manifest_path.read_text())
        manifest['archive'].update(source.record(path, path.name))
        manifest_path.write_bytes(source.encoded(manifest))
        return path

    def test_archive_members_are_closed_regular_and_exact(self):
        content = (self.root / 'LICENSE').read_bytes()
        valid = (source.PREFIX + 'LICENSE', content, tarfile.REGTYPE)
        for label, entries, message in [
            ('traversal', [('../escape', b'bad', tarfile.REGTYPE)], 'Unsafe member path'),
            ('symlink', [(source.PREFIX + 'link', b'', tarfile.SYMTYPE)], 'nonregular'),
            ('hardlink', [(source.PREFIX + 'link', b'', tarfile.LNKTYPE)], 'nonregular'),
            ('unlisted', [(source.PREFIX + 'unlisted', b'bad', tarfile.REGTYPE)], 'Unexpected'),
            ('duplicate', [valid, valid], 'duplicate'),
            ('missing', [valid], 'Incomplete'),
            ('changed', [(source.PREFIX + 'LICENSE', b'x' + content[1:], tarfile.REGTYPE)], 'hash mismatch'),
        ]:
            with self.subTest(label=label):
                path = self.archive(entries)
                with self.assertRaisesRegex(ValueError, message):
                    source.verify_archive(path, self.root)

    def test_whole_archive_binding_rejects_substitution(self):
        path = self.archive([])
        with path.open('ab') as stream:
            stream.write(b'changed')
        with self.assertRaisesRegex(ValueError, 'Source identity mismatch'):
            source.verify_archive(path, self.root)


if __name__ == '__main__':
    unittest.main()
