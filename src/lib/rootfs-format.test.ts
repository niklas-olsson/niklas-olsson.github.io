// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

interface Entry {
  kind: string;
  data?: Uint8Array;
  target?: string;
}
interface RootfsParser {
  parseTar(bytes: Uint8Array): Map<string, Entry>;
  serialize(entries: Map<string, Entry>): Map<string, Uint8Array>;
}
const context = vm.createContext({
  TextEncoder,
  TextDecoder,
  Uint8Array,
  ArrayBuffer,
});
vm.runInContext(
  await readFile(
    new URL("../../public/runtime/tinyemu/filesystem.js", import.meta.url),
    "utf8",
  ),
  context,
);
const parser = context.TerrariumRootfs as RootfsParser;
const encoder = new TextEncoder();

function archive(
  records: {
    name: string;
    type?: string;
    target?: string;
    data?: string;
    size?: number;
  }[],
): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const record of records) {
    const header = new Uint8Array(512);
    const write = (offset: number, length: number, text: string) =>
      header.set(encoder.encode(text).subarray(0, length), offset);
    const data = encoder.encode(record.data ?? "");
    write(0, 100, record.name);
    write(100, 8, "0000755");
    write(108, 8, "0000000");
    write(116, 8, "0000000");
    write(124, 12, (record.size ?? data.length).toString(8).padStart(11, "0"));
    write(136, 12, "00000000000");
    header.fill(32, 148, 156);
    write(156, 1, record.type ?? "0");
    write(157, 100, record.target ?? "");
    write(257, 6, "ustar");
    write(
      148,
      8,
      header
        .reduce((sum, value) => sum + value, 0)
        .toString(8)
        .padStart(6, "0") + "\0 ",
    );
    const content = new Uint8Array(Math.ceil(data.length / 512) * 512);
    content.set(data);
    chunks.push(header, content);
  }
  chunks.push(new Uint8Array(1024));
  const output = new Uint8Array(
    chunks.reduce((sum, bytes) => sum + bytes.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

test("rootfs tar preserves regular files, directories, symlinks and hard-link contents", () => {
  const entries = parser.parseTar(
    archive([
      { name: "./etc/", type: "5" },
      { name: "./etc/message", data: "hello λ" },
      { name: "link", type: "2", target: "/etc/message" },
      { name: "copy", type: "1", target: "./etc/message" },
    ]),
  );
  assert.equal(entries.get("etc")?.kind, "dir");
  assert.equal(new TextDecoder().decode(entries.get("copy")?.data), "hello λ");
  assert.equal(entries.get("link")?.target, "/etc/message");
  const serialized = parser.serialize(entries);
  assert.match(
    new TextDecoder().decode(serialized.get("fs/head")),
    /RootID: 1/,
  );
  assert.match(
    new TextDecoder().decode(serialized.get("fs/files/0000000000000001")),
    /"message"/,
  );
});

test("rootfs rejects archive paths that escape or contain controls", () => {
  for (const name of [
    "../escape",
    "/absolute",
    "safe/../../escape",
    "bad\nname",
  ]) {
    assert.throws(
      () => parser.parseTar(archive([{ name, data: "x" }])),
      /path/i,
    );
  }
});

test("rootfs rejects broken checksums and truncated or oversized entries", () => {
  const corrupt = archive([{ name: "a", data: "ok" }]);
  corrupt[0] ^= 1;
  assert.throws(() => parser.parseTar(corrupt), /checksum/);
  assert.throws(
    () => parser.parseTar(archive([{ name: "huge", size: 65 * 1024 * 1024 }])),
    /bounds/,
  );
  assert.throws(
    () => parser.parseTar(archive([{ name: "truncated", size: 10_000 }])),
    /bounds/,
  );
});

test("rootfs rejects missing and cyclic hard links", () => {
  assert.throws(
    () =>
      parser.parseTar(archive([{ name: "a", type: "1", target: "missing" }])),
    /hard link/,
  );
  assert.throws(
    () =>
      parser.parseTar(
        archive([
          { name: "a", type: "1", target: "b" },
          { name: "b", type: "1", target: "a" },
        ]),
      ),
    /hard link/,
  );
});

test("rootfs cannot serialize a child through a symlink parent", () => {
  const entries = parser.parseTar(
    archive([
      { name: "etc", type: "2", target: "/tmp" },
      { name: "etc/file", data: "x" },
    ]),
  );
  assert.throws(() => parser.serialize(entries), /directory parent/);
});
