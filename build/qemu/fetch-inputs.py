#!/usr/bin/env python3
"""Fetch and verify the exact public inputs in inputs.lock.json. No builds run."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from urllib.request import urlopen


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def verify(path: Path, item: dict) -> None:
    if path.stat().st_size != item["bytes"] or digest(path) != item["sha256"]:
        raise ValueError(f"Pinned input mismatch: {item['file']}. Preserve the lock; replace the cache entry.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", required=True, type=Path)
    parser.add_argument("--lock", type=Path, default=Path(__file__).with_name("inputs.lock.json"))
    parser.add_argument("--offline", action="store_true")
    args = parser.parse_args()
    lock = json.loads(args.lock.read_text())
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    for item in lock["inputs"]:
        name = item["file"]
        if Path(name).name != name or not item["url"].startswith("https://"):
            raise ValueError("Invalid pinned input metadata")
        target = args.cache_dir / name
        if not target.exists():
            if args.offline:
                raise FileNotFoundError(f"Missing pinned input: {target}")
            temporary = target.with_suffix(target.suffix + ".partial")
            try:
                with urlopen(item["url"], timeout=120) as response, temporary.open("wb") as output:
                    total = 0
                    while chunk := response.read(1024 * 1024):
                        total += len(chunk)
                        if total > item["bytes"]:
                            raise ValueError(f"Oversized input: {name}")
                        output.write(chunk)
                verify(temporary, item)
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)
        verify(target, item)
        print(f"verified {name} {item['sha256']}", flush=True)


if __name__ == "__main__":
    main()
