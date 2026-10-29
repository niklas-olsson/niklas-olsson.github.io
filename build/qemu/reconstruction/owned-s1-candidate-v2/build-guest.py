#!/usr/bin/env python3
"""Assemble the locked Alpine guest from distribution binaries. Does not compile Linux."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import struct
import subprocess
import sys
import tarfile


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def allocated_inodes(disk):
    """Read allocation bitmaps from this recipe's bounded 4-KiB ext4 image. Never mutate them."""
    with disk.open("rb") as stream:
        stream.seek(1024)
        superblock = stream.read(1024)
        if struct.unpack_from("<H", superblock, 56)[0] != 0xEF53:
            raise ValueError("Missing ext4 superblock")
        count = struct.unpack_from("<I", superblock, 0)[0]
        block = 1024 << struct.unpack_from("<I", superblock, 24)[0]
        per_group = struct.unpack_from("<I", superblock, 40)[0]
        descriptor = struct.unpack_from("<H", superblock, 254)[0] or 32
        if block != 4096 or not 0 < count <= 100000 or not 0 < per_group <= block * 8 or descriptor not in [32, 64]:
            raise ValueError("Unexpected generated ext4 layout")
        for group in range((count + per_group - 1) // per_group):
            stream.seek(block + group * descriptor)
            entry = stream.read(descriptor)
            bitmap = struct.unpack_from("<I", entry, 4)[0]
            if descriptor == 64:
                bitmap |= struct.unpack_from("<I", entry, 36)[0] << 32
            if bitmap * block + block > disk.stat().st_size:
                raise ValueError("Invalid generated inode bitmap location")
            stream.seek(bitmap * block)
            bits = stream.read((per_group + 7) // 8)
            for index in range(min(per_group, count - group * per_group)):
                if bits[index // 8] & (1 << (index % 8)):
                    yield group * per_group + index + 1


def inode_normalization_commands(disk, epoch):
    """Normalize copied host ownership/times in the image, without chown on host files."""
    commands = []
    for inode in allocated_inodes(disk):
        commands.extend([f"set_inode_field <{inode}> ctime @{epoch}\n",
                         f"set_inode_field <{inode}> uid 0\n",
                         f"set_inode_field <{inode}> gid 0\n"])
    # The pinned Alpine archive declares this one non-root group. debugfs uid/gid
    # fields update both low/high halves, including when host UIDs exceed 65535.
    commands.append("set_inode_field /etc/shadow gid 42\n")
    return "".join(commands)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--python-tools-dir", type=Path)
    parser.add_argument("--host-tools-dir", type=Path)
    args = parser.parse_args()
    incoming_umask = os.umask(0o022)
    sys.dont_write_bytecode = True
    if args.python_tools_dir:
        sys.path.insert(0, str(args.python_tools_dir.resolve()))
    import pycdlib
    from guest_modules import prepare_overlay
    lock_path = Path(__file__).with_name("guest-inputs.lock.json")
    lock = json.loads(lock_path.read_text())
    tool_lock_path = Path(__file__).with_name("guest-tools.lock.json")
    tool_lock = json.loads(tool_lock_path.read_text())
    root = args.work_dir.resolve()
    if root.exists() and any(root.iterdir()):
        parser.error("--work-dir must be empty; use a second directory for a clean comparison")
    root.mkdir(parents=True, exist_ok=True)
    output = root / "artifacts"
    output.mkdir()
    tree = root / "rootfs"
    tree.mkdir()
    tree.chmod(0o755)
    for item in lock["inputs"] + tool_lock["inputs"]:
        path = args.cache_dir / item["file"]
        if path.stat().st_size != item["bytes"] or digest(path) != item["sha256"]:
            raise ValueError(f"Pinned guest input mismatch: {path}")
    qemu_lock_path = Path(__file__).with_name("inputs.lock.json")
    qemu_lock = json.loads(qemu_lock_path.read_text())
    # Firmware is selected only from the pinned source archive, not arbitrary supplied bytes.
    firmware_archive = args.cache_dir / "qemu-wasm.tar.gz"
    pin = next(item for item in qemu_lock["inputs"] if item["file"] == firmware_archive.name)
    if digest(firmware_archive) != pin["sha256"]:
        raise ValueError("Pinned QEMU firmware source archive mismatch")
    report = {"schema": "terrarium.qemu-guest-build/v1", "status": "assembling",
              "guestInputLockSha256": digest(lock_path), "qemuInputLockSha256": digest(qemu_lock_path),
              "guestToolInputLockSha256": digest(tool_lock_path),
              "moduleRecipeSha256": digest(Path(__file__).with_name("guest_modules.py")),
              "recipeSha256": digest(Path(__file__)), "imageCompatibility": lock["imageCompatibility"],
              "kernelRelease": lock["kernelRelease"], "kernelOrigin": "official Alpine ISO binary",
              "kernelRecompiled": False, "aportsRevision": lock["aportsRevision"],
              "rootBytes": lock["rootBytes"], "sourceDateEpoch": lock["sourceDateEpoch"],
              "assemblyHostUid": os.getuid(), "assemblyHostGid": os.getgid(),
              "incomingUmask": oct(incoming_umask), "assemblyUmask": "0o022",
              "ownershipPolicy": "Image inode UID/GID 0, except /etc/shadow GID 42; host ownership is never copied into the final image",
              "modePolicy": "Preserve pinned archive/initramfs permission and special bits; generated files use fixed umask 022 with an executable boot script and sticky /tmp",
              "commands": [], "artifacts": [], "limitations": ["Candidate image needs actual-guest qualification.",
              "Temporary overlay root; root changes do not persist across a new boot.",
              "Minimal BusyBox guest; Python/vim and Kubernetes are not included.",
              "Local serial root login is passwordless, for the isolated laboratory only."]}
    report["filesystemConfigSha256"] = digest(Path(__file__).with_name("mke2fs.conf"))

    def save():
        (root / "guest-build-result.json").write_text(json.dumps(report, indent=2) + "\n")

    def guest_path(name):
        parts = PurePosixPath(name).parts
        if not parts or name.startswith("/") or ".." in parts:
            raise ValueError(f"Unsafe archive path: {name}")
        return tree.joinpath(*[p for p in parts if p != "."])

    try:
        links = []
        with tarfile.open(args.cache_dir / "alpine-minirootfs-3.21.4-x86_64.tar.gz") as archive:
            for member in archive.getmembers():
                expected_ownership = (0, 42) if PurePosixPath(member.name).parts == ("etc", "shadow") else (0, 0)
                if (member.uid, member.gid) != expected_ownership:
                    raise ValueError(f"Guest archive ownership requires an explicit recipe update: {member.name}")
                if member.name in [".", "./"]:
                    continue
                path = guest_path(member.name)
                if member.isdir():
                    path.mkdir(parents=True, exist_ok=True)
                    path.chmod(member.mode & 0o7777)
                elif member.isfile():
                    path.parent.mkdir(parents=True, exist_ok=True)
                    with archive.extractfile(member) as src, path.open("wb") as dst:
                        shutil.copyfileobj(src, dst)
                    path.chmod(member.mode & 0o7777)
                elif member.issym():
                    links.append((path, member.linkname))
                else:
                    raise ValueError(f"Unsupported guest archive entry: {member.name}")
        # Create links last so no subsequent extraction follows a guest absolute symlink on the host.
        for path, target in links:
            if ".." in PurePosixPath(target).parts:
                resolved = os.path.normpath(str(path.relative_to(tree).parent / target))
                if resolved.startswith("../"):
                    raise ValueError("Guest symlink escapes guest root")
            path.symlink_to(target)
        iso = pycdlib.PyCdlib()
        iso.open(str(args.cache_dir / "alpine-virt-3.21.4-x86_64.iso"))
        for name in ["vmlinuz-virt", "initramfs-virt", "config-" + lock["kernelRelease"], "System.map-" + lock["kernelRelease"]]:
            iso.get_file_from_iso(str(output / name), rr_path="/boot/" + name)
        modloop = io.BytesIO()
        iso.get_file_from_iso_fp(modloop, rr_path="/boot/modloop-virt")
        iso.close()
        # Retain the initramfs kernel modules and dependency indexes in the assembled root.
        data = gzip.decompress((output / "initramfs-virt").read_bytes())
        pos = 0
        while data[pos:pos + 6] in (b"070701", b"070702"):
            fields = [int(data[pos + 6 + i * 8:pos + 14 + i * 8], 16) for i in range(13)]
            size, namesize, mode = fields[6], fields[11], fields[1]
            name = data[pos + 110:pos + 110 + namesize - 1].decode()
            pos = (pos + 110 + namesize + 3) & ~3
            if name == "TRAILER!!!":
                break
            if name.startswith("lib/modules/"):
                if fields[2:4] != [0, 0]:
                    raise ValueError(f"Guest module ownership requires an explicit recipe update: {name}")
                path = guest_path(name)
                if mode & 0o170000 == 0o040000:
                    path.mkdir(parents=True, exist_ok=True)
                    path.chmod(mode & 0o7777)
                elif mode & 0o170000 == 0o100000:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(data[pos:pos + size])
                    path.chmod(mode & 0o7777)
            pos = (pos + size + 3) & ~3
        # Existing data/evidence volumes use ext2. Keep the small initramfs subset,
        # adding only its exact missing ext2 dependency closure from the same ISO.
        module_directory = tree / "lib/modules" / lock["kernelRelease"]
        module_files, module_report = prepare_overlay(modloop.getvalue(), module_directory,
            args.cache_dir / "PySquashfsImage-0.9.0-py2.py3-none-any.whl")
        modloop.close()
        for name, content in sorted(module_files.items()):
            path = module_directory / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
            path.chmod(0o644)
        for name in module_report["removeIndexes"]:
            (module_directory / name).unlink(missing_ok=True)
        (output / "module-supplement.json").write_text(json.dumps(module_report, indent=2, sort_keys=True) + "\n")
        report["moduleSupplementSha256"] = digest(output / "module-supplement.json")
        for name in ["proc", "sys", "dev", "run", "tmp", "root", "etc/init.d"]:
            (tree / name).mkdir(parents=True, exist_ok=True)
        (tree / "tmp").chmod(0o1777)
        (tree / "etc/inittab").write_text("::sysinit:/etc/init.d/terrarium-boot\nttyS0::respawn:/sbin/getty -L 115200 ttyS0 vt100\n::ctrlaltdel:/sbin/reboot\n::shutdown:/bin/sync\n")
        boot = tree / "etc/init.d/terrarium-boot"
        boot.write_text("#!/bin/sh\nset -eu\nmount -t proc proc /proc\nmount -t sysfs sysfs /sys\nmkdir -p /dev/pts /run /tmp\nmount -t devpts devpts /dev/pts\nhostname terrarium\n/bin/busybox mdev -s\n")
        boot.chmod(0o755)
        shadow = tree / "etc/shadow"
        shadow.write_text("\n".join("root::0:0:99999:7:::" if line.startswith("root:") else line for line in shadow.read_text().splitlines()) + "\n")
        (tree / "root/.profile").write_text("export TERM=xterm-256color\n")
        (tree / "etc/hostname").write_text("terrarium\n")
        (tree / "etc/securetty").write_text("console\nttyS0\nttyS1\nttyS2\nttyS3\n")
        (tree / "etc/fstab").write_text("# Terrarium: read-only root with temporary overlay, mounted by initramfs.\n")
        (tree / "etc/terrarium-image.json").write_text(json.dumps({"schema": "terrarium.guest-identity/v1", "image": lock["imageCompatibility"], "kernel": lock["kernelRelease"]}, sort_keys=True) + "\n")
        shutil.copyfile(tree / "lib/apk/db/installed", output / "installed-packages.txt")
        epoch = lock["sourceDateEpoch"]
        for directory, dirs, files in os.walk(tree, followlinks=False):
            for name in dirs + files:
                os.utime(Path(directory) / name, (epoch, epoch), follow_symlinks=False)
            os.utime(directory, (epoch, epoch))
        disk = output / "disk-rootfs.img"
        with disk.open("wb") as stream:
            stream.truncate(lock["rootBytes"])
        env = {**os.environ, "SOURCE_DATE_EPOCH": str(epoch), "E2FSPROGS_FAKE_TIME": str(epoch), "TZ": "UTC", "LC_ALL": "C",
               "MKE2FS_CONFIG": str(Path(__file__).with_name("mke2fs.conf"))}
        if args.host_tools_dir:
            host = args.host_tools_dir.resolve()
            env["PATH"] = str(host / "sbin") + ":" + str(host / "bin") + ":" + env["PATH"]
        version = subprocess.run(["mke2fs", "-V"], env=env, capture_output=True, text=True)
        if version.returncode or not version.stderr.startswith("mke2fs 1.47.0 "):
            raise ValueError("This recipe requires the pinned e2fsprogs 1.47.0 toolchain")
        report["mke2fsVersion"] = version.stderr.strip()
        report["mke2fsExecutableSha256"] = digest(Path(shutil.which("mke2fs", path=env["PATH"])))
        command = ["mke2fs", "-q", "-t", "ext4", "-F", "-b", "4096", "-I", "256", "-m", "0", "-U", "8c5727ac-22bf-5b2e-bb65-0f3f22b80800",
                   "-O", "^has_journal,^metadata_csum_seed", "-E", "lazy_itable_init=0,lazy_journal_init=0,hash_seed=847b5c1a-f863-5cdf-adc8-653a9ae80800",
                   "-d", str(tree), str(disk)]
        report["commands"].append(command)
        with (root / "filesystem-build.log").open("w") as log:
            subprocess.run(command, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
            # mke2fs copies host ownership and ctime. Normalize only allocated inodes
            # inside the image; debugfs recomputes inode checksums through libext2fs.
            commands = root / "normalize-inodes.debugfs"
            commands.write_text(inode_normalization_commands(disk, epoch))
            normalize_command = ["debugfs", "-w", "-f", str(commands), str(disk)]
            check_command = ["e2fsck", "-fn", str(disk)]
            report["commands"].extend([normalize_command, check_command])
            report["inodeNormalizationSha256"] = digest(commands)
            subprocess.run(normalize_command, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
            subprocess.run(check_command, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
        # Simple uncompressed package data is supported by the existing engine; this candidate
        # intentionally avoids executing generated preload JS or inventing a compressed index.
        packages = {}
        for kind, names in [("kernel", ["vmlinuz-virt"]), ("initramfs", ["initramfs-virt"]), ("rootfs", ["disk-rootfs.img"])]:
            filename = f"load-{kind}.data"
            shutil.copyfile(output / names[0], output / filename)
            size = (output / filename).stat().st_size
            packages[kind] = {"file": filename, "bytes": size, "sha256": digest(output / filename),
                              "metadata": {"files": [{"filename": f"/pack-{kind}/{names[0]}", "start": 0, "end": size}], "remote_package_size": size}}
        rom_names = ["bios-256k.bin", "efi-virtio.rom", "kvmvapic.bin", "linuxboot_dma.bin", "vgabios-stdvga.bin"]
        rom_files = []
        with tarfile.open(firmware_archive) as archive, (output / "load-rom.data").open("wb") as stream:
            for name in rom_names:
                member = next(m for m in archive.getmembers() if m.name.endswith("/pc-bios/" + name))
                start = stream.tell()
                stream.write(archive.extractfile(member).read())
                rom_files.append({"filename": "/pack-rom/" + name, "start": start, "end": stream.tell()})
        rom = output / "load-rom.data"
        packages["rom"] = {"file": rom.name, "bytes": rom.stat().st_size, "sha256": digest(rom), "metadata": {"files": rom_files, "remote_package_size": rom.stat().st_size}}
        manifest = {"schema": "terrarium.qemu-packages/v1", "source": {"repository": "terrarium-owned-guest", "commit": lock["imageCompatibility"]},
                    "guest": {"architecture": "x86_64", "distribution": lock["distribution"], "kernel": lock["kernelRelease"], "rootBytes": lock["rootBytes"]}, "packages": packages}
        (output / "alpine-packages.json").write_text(json.dumps(manifest, separators=(",", ":")) + "\n")
        for path in sorted(output.iterdir()):
            report["artifacts"].append({"file": path.name, "bytes": path.stat().st_size, "sha256": digest(path)})
        report["status"] = "assembled-unqualified"
        save()
        print(json.dumps({"status": report["status"], "artifacts": str(output), "kernel": lock["kernelRelease"]}))
    except Exception as exc:
        report.update(status="failed", error=str(exc))
        save()
        raise


if __name__ == "__main__":
    main()
