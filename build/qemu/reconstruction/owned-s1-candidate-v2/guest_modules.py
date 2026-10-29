#!/usr/bin/env python3
"""Prepare a deterministic ext2-only module overlay from the pinned Alpine ISO.

This helper never installs/loads kernel modules or mutates the supplied base.
The caller's guest builder applies the returned regular-file bytes and removals.
Only the known ISO/modloop and reader wheel are accepted; this is not a general
untrusted-image extraction interface. XZ uses Python's standard-library lzma.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import struct
import sys

KERNEL = "6.12.38-0-virt"
ISO_BYTES = 67108864
ISO_SHA256 = "c72ea5ba6d3acd5dda963e3926032bd73aaef8f52ec1da71927ed1b59748d00c"
MODLOOP_BYTES = 20873216
MODLOOP_SHA256 = "2d6d9d7bf37bc2ad0c120670d8c0622eb68c46c59364733d568e2cd3da0991a4"
WHEEL_BYTES = 43220
WHEEL_SHA256 = "a8ea154bf946f985c65fab7d8c08dc73da7ad47a0aebf0d13ae50ae56e369f90"
MODULES = {
    "kernel/fs/ext2/ext2.ko": (282271, "df5c8bd80a421814337fb29da079451e7d621339a03efbb9872b64574dced4b5"),
    "kernel/fs/mbcache.ko": (29151, "e86598a297ced8fcb01ead1be6846e8d59beb24c31a528347d9083afa41dfa61"),
}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def verified(data, size, digest, label):
    if len(data) != size or sha256(data) != digest:
        raise ValueError(f"Pinned {label} mismatch")
    return data


def elf_modinfo(data):
    """Read only a bounded ELF64 little-endian x86_64 module's .modinfo section."""
    if data[:6] != b"\x7fELF\x02\x01" or struct.unpack_from("<HH", data, 16) != (1, 62):
        raise ValueError("Expected an ELF64 little-endian x86_64 relocatable module")
    offset = struct.unpack_from("<Q", data, 40)[0]
    entry_size, count, names_index = struct.unpack_from("<HHH", data, 58)
    if entry_size != 64 or not 0 < count <= 1024 or names_index >= count or offset + count * 64 > len(data):
        raise ValueError("Unexpected ELF section table")
    sections = [struct.unpack_from("<IIQQQQIIQQ", data, offset + i * 64) for i in range(count)]
    names_section = sections[names_index]
    names = data[names_section[4]:names_section[4] + names_section[5]]
    for section in sections:
        name_end = names.find(b"\0", section[0])
        if name_end < 0:
            raise ValueError("Invalid ELF section name")
        if names[section[0]:name_end] == b".modinfo":
            start, length = section[4:6]
            if length > 65536 or start + length > len(data):
                raise ValueError("Unexpected ELF module metadata size")
            fields = {}
            for item in data[start:start + length].split(b"\0"):
                if item:
                    key, value = item.decode("ascii").split("=", 1)
                    fields.setdefault(key, []).append(value)
            return fields
    raise ValueError("Missing ELF module metadata")


def prepare_overlay(modloop, base_modules, reader_wheel):
    """Return {relative module-directory path: bytes}, plus deterministic evidence."""
    verified(modloop, MODLOOP_BYTES, MODLOOP_SHA256, "Alpine modloop")
    wheel = Path(reader_wheel).resolve()
    verified(wheel.read_bytes(), WHEEL_BYTES, WHEEL_SHA256, "PySquashfsImage wheel")
    # Import the verified pure-Python wheel directly; no installer or setup hook.
    if "PySquashfsImage" in sys.modules:
        raise ValueError("Run module supplementation in a fresh process")
    sys.path.insert(0, str(wheel))
    try:
        from PySquashfsImage import SquashFsImage
    finally:
        sys.path.pop(0)
    base_modules = Path(base_modules)
    files = {}
    report = {
        "schema": "terrarium.guest-module-supplement/v1", "kernelRelease": KERNEL,
        "source": {"isoBytes": ISO_BYTES, "isoSha256": ISO_SHA256,
                   "isoMember": "/boot/modloop-virt", "modloopBytes": MODLOOP_BYTES,
                   "modloopSha256": MODLOOP_SHA256},
        "reader": {"package": "PySquashfsImage", "version": "0.9.0",
                   "wheelBytes": WHEEL_BYTES, "wheelSha256": WHEEL_SHA256,
                   "compression": "XZ via Python standard-library lzma"},
        "modules": [], "indexes": [],
        "removeIndexes": ["modules.alias.bin", "modules.dep.bin", "modules.symbols.bin"],
        "indexPolicy": "Preserve initramfs text indexes and append exact ext2 closure entries; remove stale binary dep/alias/symbol indexes. BusyBox 1.37 modprobe reads text modules.dep/modules.alias/modules.symbols.",
        "limitations": ["No kernel/module recompilation or real guest execution is performed by this helper."]
    }
    prefix = f"/modules/{KERNEL}/"
    with SquashFsImage.from_bytes(modloop) as image:
        if image.sblk.compression != 4 or image.sblk.s_major != 4 or image.sblk.s_minor != 0:
            raise ValueError("Expected the pinned SquashFS 4 XZ layout")
        def read_member(name):
            path = PurePosixPath(name)
            if path.is_absolute() or ".." in path.parts:
                raise ValueError("Unsafe module member path")
            entry = image.select(prefix + name)
            if entry is None or not entry.is_file or entry.is_symlink or (entry.uid, entry.gid) != (0, 0):
                raise ValueError(f"Expected root-owned regular module member: {name}")
            if entry.size > 1024 * 1024:
                raise ValueError(f"Unexpectedly large module member: {name}")
            data = entry.read_bytes()
            if len(data) != entry.size:
                raise ValueError(f"Truncated module member: {name}")
            return data, entry.mode & 0o7777

        dep_data, _ = read_member("modules.dep")
        dependencies = {}
        for line in dep_data.decode().splitlines():
            module, rest = line.split(":", 1)
            if module in dependencies:
                raise ValueError("Duplicate dependency entry")
            dependencies[module] = rest.split()
        closure = set()
        def visit(module):
            if module in closure:
                return
            closure.add(module)
            for dependency in dependencies[module]:
                visit(dependency)
        visit("kernel/fs/ext2/ext2.ko")
        if closure != set(MODULES) or dependencies["kernel/fs/ext2/ext2.ko"] != ["kernel/fs/mbcache.ko"]:
            raise ValueError("The ext2 dependency closure changed")
        for name in sorted(closure):
            data, mode = read_member(name)
            verified(data, *MODULES[name], name)
            info = elf_modinfo(data)
            if len(info.get("vermagic", [])) != 1 or not info["vermagic"][0].startswith(KERNEL + " "):
                raise ValueError("Module kernel vermagic does not match")
            expected_depends = "mbcache" if name.endswith("ext2.ko") else ""
            if info.get("depends") != [expected_depends]:
                raise ValueError("ELF module dependencies disagree with modules.dep")
            present = base_modules / name
            if present.exists() and present.read_bytes() != data:
                raise ValueError(f"Existing dependency differs from the pinned modloop: {name}")
            if mode != 0o644:
                raise ValueError("Unexpected module file permissions")
            files[name] = data
            report["modules"].append({"path": name, "bytes": len(data), "sha256": sha256(data),
                "mode": "0644", "uid": 0, "gid": 0, "alreadyPresentIdentically": present.exists(),
                "dependencies": dependencies[name], "modinfo": info})

        added_names = {Path(name).stem for name in closure if not (base_modules / name).exists()}
        for name in ("modules.dep", "modules.alias", "modules.symbols"):
            original = (base_modules / name).read_bytes()
            source, _ = read_member(name)
            original_lines = original.decode().splitlines()
            if name == "modules.dep":
                additions = [line for line in source.decode().splitlines() if line.split(":", 1)[0] in closure]
                known = {line.split(":", 1)[0]: line for line in original_lines}
                for line in additions:
                    key = line.split(":", 1)[0]
                    if key in known and known[key] != line:
                        raise ValueError(f"Existing dependency index conflicts for {key}")
            else:
                additions = [line for line in source.decode().splitlines() if line.split() and line.split()[-1] in added_names]
            additions = sorted(set(additions) - set(original_lines))
            updated = original
            if additions:
                updated += (b"" if not original or original.endswith(b"\n") else b"\n") + ("\n".join(additions) + "\n").encode()
            files[name] = updated
            report["indexes"].append({"path": name, "sourceBytes": len(source), "sourceSha256": sha256(source),
                "originalBytes": len(original), "originalSha256": sha256(original),
                "bytes": len(updated), "sha256": sha256(updated), "appendedLines": additions})
        if "alias fs-ext2 ext2" not in files["modules.alias"].decode().splitlines():
            raise ValueError("Missing ext2 filesystem alias")
    return files, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--iso", type=Path, required=True)
    parser.add_argument("--reader-wheel", type=Path, required=True)
    parser.add_argument("--python-tools-dir", type=Path, required=True)
    parser.add_argument("--base-modules", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    iso_bytes = args.iso.read_bytes()
    verified(iso_bytes, ISO_BYTES, ISO_SHA256, "Alpine ISO")
    sys.path.insert(0, str(args.python_tools_dir.resolve()))
    import pycdlib
    with io.BytesIO(iso_bytes) as stream:
        iso = pycdlib.PyCdlib()
        iso.open_fp(stream)
        modloop = io.BytesIO()
        iso.get_file_from_iso_fp(modloop, rr_path="/boot/modloop-virt")
        iso.close()
    files, report = prepare_overlay(modloop.getvalue(), args.base_modules, args.reader_wheel)
    args.output_dir.mkdir(parents=True, exist_ok=False)
    for name, data in sorted(files.items()):
        path = args.output_dir / "overlay" / "lib/modules" / KERNEL / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        path.chmod(0o644)
    (args.output_dir / "module-supplement.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"status": "prepared", "modules": [record["path"] for record in report["modules"]], "output": str(args.output_dir)}))


if __name__ == "__main__":
    main()
