#!/usr/bin/env python3
"""Build the small auditable RAM validation fixture; never execute it on the host."""
import argparse
import base64
import datetime
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

HERE = Path(__file__).resolve().parent


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def guest_commands(data):
    """Each command is acknowledged before the next, within commandFrame's limit."""
    path = "/tmp/terrarium-memory-probe"
    sha = hashlib.sha256(data).hexdigest()
    commands = [f"set -e; : > {path}"]
    for offset in range(0, len(data), 4096):
        encoded = base64.b64encode(data[offset:offset + 4096]).decode()
        commands.append(f"set -e; printf '%s' '{encoded}' | base64 -d >> {path}")
    commands.append(f"set -e; test \"$(sha256sum {path} | cut -d ' ' -f 1)\" = {sha}; chmod 700 {path}; {path}; rm {path}")
    if any(len(command.encode()) > 8192 for command in commands):
        raise ValueError("Guest command exceeds the unchanged production input budget")
    return {"schema": "terrarium.guest-command-sequence/v1", "artifactSha256": sha,
            "artifactBytes": len(data), "maximumCommandBytes": 8192, "binaryChunkBytes": 4096,
            "commands": commands, "commandBytes": [len(command.encode()) for command in commands],
            "procedure": "Await each command's completion and zero exit status before sending the next; the final command checks the decoded ELF SHA256 before executing it."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    destination = args.output_dir.resolve()
    destination.mkdir(parents=True, exist_ok=False)
    source = destination / "memory-probe-x86_64.S"
    shutil.copyfile(HERE / source.name, source)
    tools = {name: Path(shutil.which(name)).resolve() for name in ["as", "ld", "strip"]}
    report = {"schema": "terrarium.ram-probe-build/v1", "status": "running", "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "sourceSha256": digest(source), "tools": {}, "commands": [],
              "scope": "Syscall-only guest validation fixture; this build does not run Linux or establish a RAM gate pass."}
    for name, path in tools.items():
        report["tools"][name] = {"path": str(path), "sha256": digest(path), "version": subprocess.check_output([path, "--version"], text=True).splitlines()[0]}
    binary = destination / "terrarium-memory-probe"
    commands = [[str(tools["as"]), "--64", "-o", "memory-probe.o", source.name],
                [str(tools["ld"]), "-m", "elf_x86_64", "-nostdlib", "-static", "--build-id=none", "-o", binary.name, "memory-probe.o"],
                [str(tools["strip"]), "--strip-all", binary.name]]
    try:
        for number, command in enumerate(commands):
            log = destination / f"{number:02}-build.log"
            with log.open("x") as stream:
                completed = subprocess.run(command, cwd=destination, stdout=stream, stderr=subprocess.STDOUT, timeout=15)
            report["commands"].append({"command": command, "cwd": str(destination), "exitCode": completed.returncode, "log": log.name})
            if completed.returncode:
                raise RuntimeError("Probe fixture build failed")
        data = binary.read_bytes()
        if data[:6] != b"\x7fELF\x02\x01" or int.from_bytes(data[18:20], "little") != 62:
            raise ValueError("Expected a static Linux x86_64 ELF fixture")
        encoded = base64.b64encode(data).decode()
        command = "set -e; printf '%s' '" + encoded + "' | base64 -d > /tmp/terrarium-memory-probe; chmod 700 /tmp/terrarium-memory-probe; /tmp/terrarium-memory-probe; rm /tmp/terrarium-memory-probe"
        # Retain the development one-shot artifact for comparison. It is too
        # large for production commandFrame and must not be used for a gate.
        (destination / "guest-command.txt").write_text(command + "\n")
        sequence = guest_commands(data)
        (destination / "guest-commands.json").write_text(json.dumps(sequence, indent=2) + "\n")
        report.update(status="built-not-executed", artifact={"file": binary.name, "bytes": len(data), "sha256": digest(binary)},
                      guestCommandBytes=len(command.encode()), oneShotCommandQualification="development-only; exceeds production commandFrame input budget",
                      commandSequence={"file": "guest-commands.json", "sha256": digest(destination / "guest-commands.json"),
                                       "commands": len(sequence["commands"]), "largestCommandBytes": max(sequence["commandBytes"])})
    except Exception as error:
        report.update(status="failed", error=str(error))
        raise
    finally:
        report["finishedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (destination / "build-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print("MEMORY_PROBE_FIXTURE_BUILT " + json.dumps(report["artifact"]))


if __name__ == "__main__":
    main()
