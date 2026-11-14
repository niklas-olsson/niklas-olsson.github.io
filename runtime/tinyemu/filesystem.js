// SPDX-License-Identifier: Apache-2.0
// Convert verified upstream rootfs archives to TinyEMU's in-memory 9p format.
// This code never writes archive paths to the host filesystem or fetches URLs.
(() => {
  "use strict";
  const MAX_ARCHIVE_BYTES = 192 * 1024 * 1024;
  const MAX_FILE_BYTES = 64 * 1024 * 1024;
  const MAX_ENTRIES = 20_000;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();

  function field(bytes) {
    const end = bytes.indexOf(0);
    return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
  }

  function number(bytes) {
    if (bytes[0] & 0x80)
      throw new Error("Base-256 tar fields are not supported.");
    const text = field(bytes).trim();
    if (!text) return 0;
    if (!/^[0-7]+$/.test(text)) throw new Error("Invalid tar number.");
    const value = Number.parseInt(text, 8);
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("Unsafe tar number.");
    return value;
  }

  function path(value) {
    const normalized = value.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
    if (!normalized || normalized === ".") return "";
    if (
      normalized.startsWith("/") ||
      normalized.length > 1023 ||
      /[\x00-\x1f\x7f]/.test(normalized)
    )
      throw new Error("Invalid rootfs path.");
    if (
      normalized
        .split("/")
        .some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            encoder.encode(part).length > 255,
        )
    )
      throw new Error("Unsafe rootfs path.");
    return normalized;
  }

  function pax(bytes) {
    const result = Object.create(null);
    let offset = 0;
    while (offset < bytes.length) {
      const space = bytes.indexOf(32, offset);
      if (space < 0 || space - offset > 10)
        throw new Error("Invalid PAX record.");
      const lengthText = decoder.decode(bytes.subarray(offset, space));
      if (!/^\d+$/.test(lengthText)) throw new Error("Invalid PAX length.");
      const length = Number(lengthText);
      if (
        !Number.isSafeInteger(length) ||
        length <= space - offset + 2 ||
        offset + length > bytes.length ||
        bytes[offset + length - 1] !== 10
      )
        throw new Error("Truncated PAX record.");
      const record = decoder.decode(
        bytes.subarray(space + 1, offset + length - 1),
      );
      const separator = record.indexOf("=");
      if (separator < 1) throw new Error("Invalid PAX key.");
      result[record.slice(0, separator)] = record.slice(separator + 1);
      offset += length;
    }
    return result;
  }

  function parseTar(bytes) {
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.length > MAX_ARCHIVE_BYTES ||
      bytes.length % 512 !== 0
    )
      throw new Error("Invalid rootfs tar size.");
    const entries = new Map();
    let attributes = Object.create(null);
    let globalAttributes = Object.create(null);
    let longName = null;
    let longLink = null;
    let offset = 0;
    let ended = false;
    while (offset + 512 <= bytes.length) {
      const header = bytes.subarray(offset, offset + 512);
      if (header.every((byte) => byte === 0)) {
        ended = true;
        break;
      }
      const expectedChecksum = number(header.subarray(148, 156));
      let checksum = 0;
      for (let index = 0; index < 512; index++)
        checksum += index >= 148 && index < 156 ? 32 : header[index];
      if (checksum !== expectedChecksum)
        throw new Error("Rootfs tar header checksum failed.");
      const size = number(header.subarray(124, 136));
      if (size > MAX_FILE_BYTES || offset + 512 + size > bytes.length)
        throw new Error("Rootfs tar entry exceeds its bounds.");
      const data = bytes.subarray(offset + 512, offset + 512 + size);
      offset += 512 + Math.ceil(size / 512) * 512;
      const type = String.fromCharCode(header[156] || 48);
      if (type === "x") {
        attributes = pax(data);
        continue;
      }
      if (type === "g") {
        globalAttributes = { ...globalAttributes, ...pax(data) };
        continue;
      }
      if (type === "L") {
        longName = field(data);
        continue;
      }
      if (type === "K") {
        longLink = field(data);
        continue;
      }
      const metadata = { ...globalAttributes, ...attributes };
      const prefix = field(header.subarray(345, 500));
      const name = path(
        metadata.path ??
          longName ??
          `${prefix ? `${prefix}/` : ""}${field(header.subarray(0, 100))}`,
      );
      const target =
        metadata.linkpath ?? longLink ?? field(header.subarray(157, 257));
      attributes = Object.create(null);
      longName = null;
      longLink = null;
      if (!name) continue;
      if (entries.size >= MAX_ENTRIES)
        throw new Error("Rootfs contains too many entries.");
      if (metadata.size !== undefined && Number(metadata.size) !== size)
        throw new Error("Unsupported PAX size override.");
      const entry = {
        mode: number(header.subarray(100, 108)) & 0xfff,
        uid: number(header.subarray(108, 116)),
        gid: number(header.subarray(116, 124)),
        mtime: Math.min(0xffffffff, number(header.subarray(136, 148))),
      };
      if (entry.uid > 0xffffffff || entry.gid > 0xffffffff)
        throw new Error("Invalid rootfs owner.");
      if (type === "0" || type === "7")
        Object.assign(entry, { kind: "file", data });
      else if (type === "5") Object.assign(entry, { kind: "dir" });
      else if (type === "2") {
        if (
          !target ||
          encoder.encode(target).length > 1023 ||
          /[\x00-\x1f\x7f]/.test(target)
        )
          throw new Error("Invalid rootfs symlink.");
        Object.assign(entry, { kind: "link", target });
      } else if (type === "1")
        Object.assign(entry, { kind: "hardlink", target: path(target) });
      else if (type === "3" || type === "4")
        Object.assign(entry, {
          kind: type === "3" ? "character" : "block",
          major: number(header.subarray(329, 337)),
          minor: number(header.subarray(337, 345)),
        });
      else if (type === "6") Object.assign(entry, { kind: "fifo" });
      else throw new Error(`Unsupported tar entry type ${type}.`);
      entries.set(name, entry);
    }
    if (!ended) throw new Error("Rootfs tar has no end marker.");
    const resolve = (name, visited = new Set()) => {
      const entry = entries.get(name);
      if (!entry || visited.has(name) || visited.size > 32)
        throw new Error("Invalid rootfs hard link.");
      if (entry.kind !== "hardlink") return entry;
      visited.add(name);
      const target = resolve(entry.target, visited);
      if (target.kind !== "file")
        throw new Error("Rootfs hard links must target files.");
      return target;
    };
    for (const [name, entry] of entries)
      if (entry.kind === "hardlink") entries.set(name, { ...resolve(name) });
    return entries;
  }

  async function decompress(buffer) {
    if (typeof DecompressionStream === "undefined")
      throw new Error(
        "This profile requires browser gzip decompression support.",
      );
    if (
      !(buffer instanceof ArrayBuffer) ||
      buffer.byteLength > 64 * 1024 * 1024
    )
      throw new Error("Rootfs download exceeds its limit.");
    const reader = new Blob([buffer])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"))
      .getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_ARCHIVE_BYTES)
          throw new Error("Expanded rootfs exceeds 192 MiB.");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return parseTar(bytes);
  }

  function add(entries, name, kind, value, mode = 0o755) {
    const parent = name.split("/").slice(0, -1);
    for (let length = 1; length <= parent.length; length++) {
      const directory = parent.slice(0, length).join("/");
      if (!entries.has(directory))
        entries.set(directory, {
          kind: "dir",
          mode: 0o755,
          uid: 0,
          gid: 0,
          mtime: 0,
        });
      if (entries.get(directory).kind !== "dir")
        throw new Error("Rootfs integration parent must be a directory.");
    }
    entries.set(name, {
      kind,
      ...(kind === "file"
        ? { data: typeof value === "string" ? encoder.encode(value) : value }
        : kind === "link"
          ? { target: value }
          : {}),
      mode,
      uid: 0,
      gid: 0,
      mtime: 0,
    });
  }

  function configure(entries, profileId, support) {
    let busybox = "/bin/busybox";
    let shell = "/bin/sh -l";
    if (profileId === "debian-riscv64") {
      const executable = support?.get("bin/busybox");
      const loader = support?.get("lib/ld-musl-riscv64.so.1");
      if (executable?.kind !== "file" || loader?.kind !== "file")
        throw new Error("The verified Debian boot utilities are missing.");
      add(entries, "usr/lib/terrarium/busybox", "file", executable.data);
      add(entries, "usr/lib/ld-musl-riscv64.so.1", "file", loader.data);
      for (const command of ["ifconfig", "route"])
        add(entries, `usr/sbin/${command}`, "link", "../lib/terrarium/busybox");
      for (const command of ["ping", "nslookup", "nc", "wget", "httpd"])
        add(entries, `usr/bin/${command}`, "link", "../lib/terrarium/busybox");
      busybox = "/usr/lib/terrarium/busybox";
      shell = "/bin/bash -l";
    } else if (profileId !== "alpine-riscv64")
      throw new Error("Unknown archive-backed guest profile.");
    const init = `#!/bin/sh\n${busybox} mount -t proc proc /proc\n${busybox} mount -t sysfs sysfs /sys\n${busybox} mkdir -p /run /tmp\n${busybox} hostname terrarium\nexport PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\nexport TERM=xterm-256color\nexec ${busybox} init\n`;
    add(entries, "terrarium-init", "file", init);
    add(
      entries,
      "etc/inittab",
      "file",
      `hvc0::respawn:${shell}\n::ctrlaltdel:${busybox} reboot\n`,
      0o644,
    );
    return entries;
  }

  function serialize(entries) {
    const assets = new Map();
    const children = new Map();
    for (const [name, entry] of entries) {
      const slash = name.lastIndexOf("/");
      const parent = slash < 0 ? "" : name.slice(0, slash);
      if (parent && entries.get(parent)?.kind !== "dir")
        throw new Error("Rootfs entry has no directory parent.");
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push([name.slice(slash + 1), name, entry]);
    }
    const lines = ["Version: 1", ""];
    let id = 2;
    const modes = {
      file: 0o100000,
      dir: 0o40000,
      link: 0o120000,
      character: 0o20000,
      block: 0o60000,
      fifo: 0o10000,
    };
    function directory(name, depth) {
      if (depth > 64)
        throw new Error("Rootfs directory nesting exceeds its limit.");
      // Code-point order keeps generated IDs deterministic across browser locales.
      for (const [filename, full, entry] of (children.get(name) ?? []).sort(
        (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
      )) {
        const parts = [
          (modes[entry.kind] | entry.mode).toString(8),
          entry.uid,
          entry.gid,
        ];
        if (entry.kind === "file") parts.push(entry.data.length);
        if (entry.kind === "character" || entry.kind === "block")
          parts.push(entry.major, entry.minor);
        parts.push(entry.mtime, JSON.stringify(filename));
        if (entry.kind === "link") parts.push(JSON.stringify(entry.target));
        if (entry.kind === "file" && entry.data.length) {
          parts.push(id.toString(16));
          assets.set(
            `fs/files/${id.toString(16).padStart(16, "0")}`,
            entry.data,
          );
          id++;
        }
        lines.push(parts.join(" "));
        if (entry.kind === "dir") {
          directory(full, depth + 1);
          lines.push(".");
        }
      }
    }
    directory("", 0);
    assets.set(
      "fs/head",
      encoder.encode("Version: 1\nRootID: 1\nFSMaxSize: 268435456\n"),
    );
    assets.set(
      "fs/files/0000000000000001",
      encoder.encode(lines.join("\n") + "\n"),
    );
    return assets;
  }

  async function fromGzip(buffer, profileId, supportBuffer) {
    const entries = await decompress(buffer);
    const support = supportBuffer ? await decompress(supportBuffer) : null;
    return serialize(configure(entries, profileId, support));
  }

  globalThis.TerrariumRootfs = Object.freeze({
    parseTar,
    configure,
    serialize,
    fromGzip,
  });
})();
