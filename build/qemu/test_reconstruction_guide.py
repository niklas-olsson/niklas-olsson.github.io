# SPDX-License-Identifier: Apache-2.0
"""Parse documented build CLIs without executing recipes or compilers."""
import argparse
import ast
from pathlib import Path
import json
import shlex
import unittest

ROOT = Path(__file__).resolve().parents[2]


def recipe_parser(path):
    main = next(n for n in ast.parse(path.read_text()).body if isinstance(n, ast.FunctionDef) and n.name == 'main')
    statements = []
    for node in main.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'args' for t in node.targets):
            break
        statements.append(node)
    scope = {'argparse': argparse, 'Path': Path, '__doc__': 'CLI fixture'}
    exec(compile(ast.Module(body=statements, type_ignores=[]), str(path), 'exec'), scope)
    return scope['parser']


class GuideTests(unittest.TestCase):
    def test_documented_runtime_commands_parse_for_each_selected_recipe(self):
        guide = (ROOT / 'build/qemu/README.md').read_text().replace('\\\n', '')
        recipe = None
        count = 0
        for line in guide.splitlines():
            if line.startswith('RECIPE='):
                recipe = line.split('=', 1)[1]
            if line.startswith('python3 -B "$RECIPE/build-runtime.py"'):
                argv = shlex.split(line)[3:]
                parser = recipe_parser(ROOT / recipe / 'build-runtime.py')
                args = parser.parse_args(argv)
                self.assertEqual(args.jobs, 4)
                count += 1
        self.assertEqual(count, 3)  # historical all-in-one plus current two-stage

    def test_current_and_server_parsers_support_documented_stages(self):
        for recipe in ['build/qemu'] + ['build/qemu/reconstruction/owned-s2-server-v' + str(i) for i in (1, 2, 3)]:
            for stage in ['dependencies', 'qemu']:
                args = recipe_parser(ROOT / recipe / 'build-runtime.py').parse_args([
                    '--cache-dir', '/cache', '--work-dir', '/work', '--sdk-dir', '/sdk', '--jobs', '4', '--stage', stage])
                self.assertEqual(args.stage, stage)

    def test_public_descriptor_is_an_identity_without_temporal_delivery_state(self):
        descriptor = json.loads((ROOT / 'public/runtime/qemu/source-manifest.json').read_text())
        self.assertNotIn('status', descriptor)
        self.assertEqual(len(descriptor['archive']['sha256']), 64)
        self.assertGreater(descriptor['archive']['bytes'], 0)
        for text in [(ROOT / 'docs/runtime-sources.md').read_text(), json.dumps(descriptor)]:
            self.assertNotIn('pending', text.lower())
            self.assertNotIn('not uploaded', text.lower())
        inventory = json.loads((ROOT / 'public/runtime/qemu/source-archive-members.json').read_text())
        self.assertNotIn('public/runtime/qemu/source-manifest.json', [m['path'] for m in inventory['members']])

    def test_historical_parser_rejects_staged_option(self):
        parser = recipe_parser(ROOT / 'build/qemu/reconstruction/owned-s1-candidate-v2/build-runtime.py')
        with self.assertRaises(SystemExit) as error:
            parser.parse_args(['--cache-dir', '/cache', '--work-dir', '/work', '--sdk-dir', '/sdk', '--stage', 'dependencies'])
        self.assertEqual(error.exception.code, 2)


if __name__ == '__main__':
    unittest.main()
