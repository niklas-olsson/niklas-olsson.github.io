#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Check the public reconstruction closure; create/verify its neutral source kit."""
from __future__ import annotations
import argparse
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
CLOSURE = 'build/qemu/distribution/manifest.json'
INVENTORY = 'public/runtime/qemu/source-archive-members.json'
DELIVERY = 'public/runtime/qemu/source-manifest.json'
PREFIX = 'terrarium-s2-runtime-corresponding-source/'
EPOCH = 1700000000
RESERVE = 2 * 1024**3
RUNTIME_SOURCES = {
    'qemu-wasm.tar.gz', 'libffi.tar.gz', 'glib.tar.xz', 'pixman.tar.gz', 'zlib.tar.gz',
    'xterm-pty.tgz', 'pcre2.tar.bz2', 'pcre2-patch.zip', 'gvdb.tar.gz', 'keycodemapdb.tar.gz',
    'dtc.tar.gz', 'berkeley-softfloat-3.tar.gz', 'berkeley-testfloat-3.tar.gz',
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def safe_path(name):
    p = PurePosixPath(name)
    require(bool(name) and not p.is_absolute() and '\\' not in name
            and all(part not in ('', '.', '..') for part in name.split('/'))
            and not any(ord(c) < 32 for c in name), 'Unsafe member path: ' + name)
    return name


def sha256(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def record(path, name):
    require(path.is_file() and not path.is_symlink(), 'Missing or nonregular source: ' + name)
    return {'path': safe_path(name), 'bytes': path.stat().st_size, 'sha256': sha256(path)}


def read_json(root, name):
    return json.loads((root / name).read_text())


def encoded(value):
    return (json.dumps(value, indent=2) + '\n').encode()


def verify_record(path, item):
    actual = record(path, item.get('path', item.get('file', str(path))))
    require(actual['bytes'] == item['bytes'] and actual['sha256'] == item['sha256'],
            'Source identity mismatch: ' + actual['path'])


def payload_paths(root):
    paths = set()
    for directory in ['build/qemu', 'public/runtime/qemu/licenses', 'vendor/qemu']:
        for p in (root / directory).rglob('*'):
            if '__pycache__' in p.parts:
                continue
            require(not p.is_symlink(), 'Source symlink: ' + str(p))
            if p.is_file():
                paths.add(p.relative_to(root).as_posix())
    qemu = root / 'public/runtime/qemu'
    for p in qemu.iterdir():
        if p.suffix in ('.js', '.ts', '.json', '.txt', '.md') and p.name not in (Path(INVENTORY).name, Path(DELIVERY).name):
            paths.add(p.relative_to(root).as_posix())
    for p in (qemu / 'bundles').glob('*/provenance.json'):
        paths.add(p.relative_to(root).as_posix())
    paths.update([
        'public/runtime/qemu/bundles/owned-s1-candidate-v2/alpine-packages.json',
        'public/runtime/qemu/bundles/owned-s1-candidate-v2/qemu-system-x86_64.worker.js',
        'scripts/prepare-qemu.mjs', 'scripts/qemu-pthread-transform.mjs',
        'scripts/qemu-pthread-transform.d.mts', 'scripts/extract-qemu-packages.mjs',
        'docs/runtime-sources.md', 'LICENSE', 'NOTICE', 'package.json',
    ])
    return sorted(paths)


def expected_inventory(root):
    closure = read_json(root, CLOSURE)
    members = [record(root / name, name) for name in payload_paths(root)]
    members += [{'path': 'source-inputs/' + safe_path(i['file']), 'bytes': i['bytes'], 'sha256': i['sha256']}
                for i in closure['sourceInputs']]
    return {'schema': 'terrarium.source-archive-members/v1', 'root': PREFIX,
            'inventoryPath': INVENTORY,
            'membership': 'All regular payload files plus this inventory. This inventory excludes itself; the external source manifest binds its exact bytes.',
            'sourceInputs': closure['sourceInputs'], 'members': sorted(members, key=lambda x: x['path'])}


def check_recipe_identities(root, closure):
    expected_bundles = {p.parent.name for p in (root / 'public/runtime/qemu/bundles').glob('*/provenance.json')}
    require({b['bundle'] for b in closure['bundles']} == expected_bundles and len(expected_bundles) == 5,
            'Owned bundle coverage changed')
    for b in closure['bundles']:
        provenance = read_json(root, 'public/runtime/qemu/bundles/' + b['bundle'] + '/provenance.json')
        source = provenance['runtimeSource']
        require(b['runtimeCompatibility'] == provenance['runtimeCompatibility'], 'Runtime identity changed')
        directory = root / safe_path(b['recipeDirectory'])
        for file, key in [('build-runtime.py', 'recipeSha256'), ('inputs.lock.json', 'inputLockSha256')]:
            require(sha256(directory / file) == b[key] == source[key], 'Historical recipe identity mismatch: ' + b['bundle'] + '/' + file)
        lock = json.loads((directory / 'inputs.lock.json').read_text())
        require(lock['candidateRuntimeCompatibility'] == b['runtimeCompatibility'], 'Recipe runtime identity mismatch')
        require(b['patches'] == source['patches'], 'Patch coverage changed')
        for file, digest in source['patches'].items():
            require(sha256(directory / 'patches' / safe_path(file)) == digest, 'Patch identity mismatch: ' + file)
        require(sha256(root / safe_path(b['guestPackagingRecipe'])) == b['guestPackagingRecipeSha256'] == provenance['guestSource']['recipeSha256'],
                'Guest packaging identity changed')
    # Derivation checks use only source transformations, never compilation/subprocesses.
    for version in ('1', '2', '3'):
        name = 'build-machine-runtime' + ('' if version == '1' else '-v' + version) + '.py'
        spec = importlib.util.spec_from_file_location('source_recipe_' + version, root / 'build/qemu' / name)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory(prefix='runtime-recipe-') as temporary:
            directory = Path(temporary) / 'derived'
            module.derive_recipe(root / 'build/qemu', directory)
            retained = root / 'build/qemu/reconstruction' / ('owned-s2-server-v' + version)
            require({p.relative_to(directory).as_posix() for p in directory.rglob('*') if p.is_file()} ==
                    {p.relative_to(retained).as_posix() for p in retained.rglob('*') if p.is_file()}, 'Derived member coverage mismatch')
            for p in directory.rglob('*'):
                if p.is_file():
                    require(p.read_bytes() == (retained / p.relative_to(directory)).read_bytes(), 'Derived recipe drift: ' + str(p.relative_to(directory)))


def check_input_selection(root, closure):
    inputs = closure['sourceInputs']
    require(len(inputs) == 39 and len({x['file'] for x in inputs}) == 39, 'Expected 39 unique original source inputs')
    selected = {}
    for name in ['inputs.lock.json', 'guest-inputs.lock.json', 'guest-tools.lock.json', 'distribution-inputs.lock.json']:
        lock = read_json(root, 'build/qemu/' + name)
        for item in lock['inputs']:
            if name in ('distribution-inputs.lock.json', 'guest-tools.lock.json') or item['file'] in RUNTIME_SOURCES or item['file'] == 'aports-v3.21.4.tar.gz':
                if item['file'] in selected:
                    require(selected[item['file']] == item, 'Conflicting original input pin')
                selected[item['file']] = item
    require(len(selected) == 37, 'Original selected input count changed')
    actual = {i['file']: i for i in inputs}
    for file, item in selected.items():
        require(actual[file] == item, 'Original source pin changed: ' + file)
    for file in ['protocols-6.4', 'services-6.4']:
        item = actual[file]
        recipe = root / safe_path(item['recipe'])
        require(sha256(recipe) == item['recipeSha256'], 'Supplemental APKBUILD changed')
        require(item['sha512'] + '  ' + file in recipe.read_text(), 'Supplemental input is not APKBUILD-pinned')
    for item in inputs:
        require('/' not in safe_path(item['file']) and item['url'].startswith('https://'), 'Unsafe source input')


def check_package_recipe_map(root, closure):
    aliases = {r['path']: r for r in closure['componentRecords'] if 'projection' in r}
    require(len(aliases) == 3, 'Upstream recipe alias coverage changed')
    for name, item in aliases.items():
        projection = item['projection']
        target = safe_path(projection['linkTarget'])
        require('/' not in target and projection['type'] == 'materialized-upstream-symlink', 'Unsafe recipe alias')
        path = root / safe_path(name)
        require(path.read_bytes() == (path.parent / target).read_bytes(), 'Materialized recipe alias changed')
    packages = read_json(root, 'build/qemu/distribution/guest/package-recipe-map.json')['packages']
    for package in packages:
        for item in package['files']:
            require(item['type'] == 'file', 'Unexpected recipe Git object type')
            name = 'build/qemu/distribution/aports/aports-v3.21.4.tar.gz/main/' + safe_path(package['origin']) + '/' + safe_path(item['name'])
            if name in aliases:
                data = aliases[name]['projection']['linkTarget'].encode()
            else:
                data = (root / name).read_bytes()
            blob = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
            require(blob == item['gitObjectSha'], 'Package recipe Git blob mismatch: ' + name)


def check(root=ROOT, delivery=True):
    closure = read_json(root, CLOSURE)
    require(closure['schema'] == 'terrarium.runtime-source-closure/v1', 'Unknown closure schema')
    check_input_selection(root, closure)
    check_recipe_identities(root, closure)
    check_package_recipe_map(root, closure)
    for item in closure['componentRecords']:
        verify_record(root / safe_path(item['path']), item)
    inventory = read_json(root, INVENTORY)
    require(inventory == expected_inventory(root), 'Closed source inventory differs from public files or input pins')
    if delivery:
        manifest = read_json(root, DELIVERY)
        require(manifest['schema'] == 'terrarium.runtime-source-distribution/v1', 'Unknown delivery schema')
        for key, path in [('inventory', INVENTORY), ('closure', CLOSURE)]:
            require(manifest[key]['path'] == path, 'Public manifest path changed')
            verify_record(root / path, manifest[key])
        require(manifest['sourceInputCount'] == 39 and manifest['payloadMemberCount'] == len(inventory['members']), 'Public manifest coverage changed')
        require(manifest['archive']['format'] == 'gzip-compressed POSIX tar; regular files only' and manifest['archive']['root'] == PREFIX, 'Public archive format changed')
        require(manifest['archive']['url'] == 'https://github.com/niklas-olsson/niklas-olsson.github.io/releases/download/runtime-sources-s2/terrarium-s2-runtime-corresponding-source.tar.gz', 'Proposed source URL changed')
    return inventory


def reserves(directory, additional=0):
    available = next(int(line.split()[1]) * 1024 for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:'))
    require(available >= RESERVE, 'Less than 2 GiB available memory')
    require(shutil.disk_usage(directory).free >= RESERVE + additional, 'Less than 2 GiB disk reserve after projected output')


def create(cache, output, root=ROOT):
    inventory = check(root, delivery=False)
    output = output.resolve()
    require(not output.is_relative_to(root.resolve()), 'Source archive must remain outside the repository')
    require(not output.exists(), 'Refusing to overwrite an archive')
    reserves(output.parent, sum(i['bytes'] for i in inventory['members']) + 8 * 1024**2)
    for item in inventory['sourceInputs']:
        path = cache / item['file']
        verify_record(path, item)
        if 'sha512' in item:
            with path.open('rb') as f:
                require(hashlib.file_digest(f, 'sha512').hexdigest() == item['sha512'], 'Original SHA512 mismatch: ' + item['file'])
    entries = list(inventory['members']) + [record(root / INVENTORY, INVENTORY)]
    with output.open('xb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', filename='', mtime=EPOCH, compresslevel=9) as gz, tarfile.open(fileobj=gz, mode='w|', format=tarfile.USTAR_FORMAT) as archive:
        for item in sorted(entries, key=lambda i: i['path']):
            reserves(output.parent)
            name = safe_path(item['path'])
            path = cache / name[len('source-inputs/'):] if name.startswith('source-inputs/') else root / name
            verify_record(path, item)
            info = tarfile.TarInfo(PREFIX + name)
            info.size, info.mode, info.mtime = item['bytes'], 0o644, EPOCH
            with path.open('rb') as content:
                archive.addfile(info, content)
    return record(output, output.name)


def verify_archive(path, root=ROOT):
    inventory = check(root)
    manifest = read_json(root, DELIVERY)
    verify_record(path, manifest['archive'])
    expected = {i['path']: i for i in inventory['members']}
    expected[INVENTORY] = record(root / INVENTORY, INVENTORY)
    seen = set()
    with tarfile.open(path, mode='r|gz') as archive:
        for member in archive:
            safe_path(member.name)
            require(member.isreg() and not member.pax_headers, 'Archive has a nonregular or extended member')
            require(member.name.startswith(PREFIX), 'Wrong source archive root')
            name = member.name[len(PREFIX):]
            require(name in expected and name not in seen, 'Unexpected or duplicate archive member: ' + name)
            item = expected[name]
            require(member.size == item['bytes'], 'Archive member length mismatch: ' + name)
            content = archive.extractfile(member)
            digest = hashlib.file_digest(content, 'sha256').hexdigest()
            require(digest == item['sha256'], 'Archive member hash mismatch: ' + name)
            seen.add(name)
    require(seen == set(expected), 'Incomplete archive membership')
    return {'archive': record(path, path.name), 'payloadMembers': len(inventory['members']), 'totalMembers': len(seen), 'sourceInputs': len(inventory['sourceInputs'])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['inventory', 'check', 'create', 'verify'])
    parser.add_argument('--cache-dir', type=Path)
    parser.add_argument('--archive', type=Path)
    args = parser.parse_args()
    if args.mode == 'inventory':
        value = expected_inventory(ROOT)
        (ROOT / INVENTORY).write_bytes(encoded(value))
        print(json.dumps({'payloadMembers': len(value['members']), 'sourceInputs': len(value['sourceInputs'])}))
    elif args.mode == 'check':
        value = check()
        print(json.dumps({'status': 'source-closure-verified', 'payloadMembers': len(value['members']), 'sourceInputs': len(value['sourceInputs'])}))
    elif args.mode == 'create':
        require(args.cache_dir is not None and args.archive is not None, 'create requires --cache-dir and --archive')
        print(json.dumps(create(args.cache_dir, args.archive)))
    else:
        require(args.archive is not None, 'verify requires --archive')
        print(json.dumps(verify_archive(args.archive)))


if __name__ == '__main__':
    main()
